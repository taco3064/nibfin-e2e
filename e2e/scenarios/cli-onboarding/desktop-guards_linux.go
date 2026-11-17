//go:build linux

package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestE2EDesktopLinuxGuards(t *testing.T) {
	// The actual Linux entry must reject replacement before repository planning.
	identity := strings.Repeat("e", 32)
	if linuxIdentity() == identity {
		identity = strings.Repeat("d", 32)
	}
	api := &e2eAPI{API: initFixture()}
	var out bytes.Buffer
	err := (App{API: api, Process: e2eNoProcess{t}}).Run([]string{
		"init", "--repo", "example/project", "--apply", "--linux-target-identity",
		identity, "--linux-target-arch", "arm64",
	}, &out)
	if err == nil || err.Error() != "GUEST_TARGET_CHANGED" || out.Len() != 0 ||
		len(api.calls) != 0 {
		t.Fatal("replacement reached planning/setup", err)
	}

	for _, arch := range []string{"amd64", "arm64"} {
		for _, missing := range []string{"", "/proc/1/comm",
			"/sys/fs/cgroup/cgroup.controllers", "/sys/module/apparmor/parameters/enabled",
			"/proc/sys/user/max_user_namespaces"} {
			t.Run(arch+missing, func(t *testing.T) {
				o := e2eGuestObservation(arch, missing)
				check := requireLinuxObservation(o)
				if (check == nil) != (missing == "") {
					t.Fatal("engine preparation confused with required host isolation", o, check)
				}
				if o.Readiness != "unverified" {
					t.Fatal("protected readiness claimed")
				}
				if missing == "" {
					return
				}
				ledger := []string{}
				operations := managedHostOperations{
					prepare: func(InitPlan) error { ledger = append(ledger, "setup"); return nil },
				}
				app := App{handoffCheck: func() error { return requireLinuxObservation(o) }}
				ctx := context.Background()
				// Actual pre-setup orchestration boundaries must propagate the guard result.
				for _, run := range []func() error{
					func() error {
						return app.resumeManagedInit(ctx, InitPlan{}, nil, &bytes.Buffer{}, operations)
					},
					func() error {
						return app.finishVerifiedManagedInit(ctx, InitPlan{}, nil, nil, operations)
					},
					func() error {
						return app.finishManagedInit(ctx, InitPlan{}, nil, nil, operations)
					},
				} {
					if err := run(); err == nil || err.Error() != check.Error() {
						t.Fatal("pre-setup guard bypassed", err)
					}
				}
				if len(ledger) != 0 {
					t.Fatal("rejected observation reached setup", ledger)
				}
			})
		}
	}
}
