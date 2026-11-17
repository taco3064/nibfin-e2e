//go:build linux

package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestE2EReplacementPreview(t *testing.T) {
	d := newRebuildDriver(t)
	before := jsonRelay(d.host)
	runners := jsonRelay(d.runners)
	secrets := e2eReplacementSecrets(t, d)
	observer := newE2EReplacementObserver(t)
	hostBefore, err := os.ReadFile(observer.HostState)
	if err != nil {
		t.Fatal(err)
	}
	_, err = selectAgent("claude", true, d.host.Agent,
		func(string) (agentBinding, error) {
			t.Fatal("ordinary init resolved a conflicting provider")
			return agentBinding{}, nil
		})
	if err == nil || !strings.Contains(err.Error(), "REBUILD") {
		t.Fatal("ordinary provider conflict accepted", err)
	}
	e2eEqual(t, jsonRelay(d.host), before)
	repo := d.api.data["repos/example/project"].(Repository)
	user := d.api.data["user"].(User)
	preview, unmet, err := previewRebuild(repo, user, "claude",
		observer.operations(t, d, d.operations()))
	if err != nil || len(unmet) != 0 {
		t.Fatal(err, unmet)
	}
	e2eEqual(t, preview.Old, d.old)
	e2eEqual(t, preview.Repositories, d.repositories)
	e2eEqual(t, preview.Agent, d.binding)
	e2eEqual(t, len(d.calls), 0)
	e2eEqual(t, len(d.deletes), 0)
	e2eEqual(t, len(d.api.writes), 0)
	e2eEqual(t, len(observer.Effects), 0)
	hostAfter, err := os.ReadFile(observer.HostState)
	if err != nil {
		t.Fatal(err)
	}
	e2eEqual(t, hostAfter, hostBefore)
	e2eEqual(t, jsonRelay(d.runners), runners)
	e2eEqual(t, jsonRelay(d.host), before)
	e2eEqual(t, e2eReplacementSecrets(t, d), secrets)
	if d.retirement != nil {
		t.Fatal("preview created a retirement")
	}
	path, err := sharedMutationPath()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("preview persisted rebuild intent", err)
	}
	// Public argument validation must reject unsupported input without touching
	// the fixed installed administrator boundary. Positive apply uses private ports.
	var out bytes.Buffer
	err = (App{API: d, Process: e2eNoProcess{t}}).Run([]string{
		"runner", "rebuild", "--repo", repo.FullName, "--agent", "unknown"}, &out)
	if err == nil {
		t.Fatal("public rebuild accepted unsupported provider")
	}
	e2eEqual(t, len(d.api.writes), 0)
	e2eEqual(t, jsonRelay(d.host), before)
}

type e2eReplacementAPI struct {
	driver        *rebuildDriver
	unavailable   bool
	contradictory bool
	unrelated     RunnerInfo
}

func (a *e2eReplacementAPI) Call(method, path string, input, output any) error {
	base := "repos/example/project/actions/runners"
	if method == "GET" && strings.HasPrefix(path, base) {
		if a.unavailable {
			return errors.New("fixture readback unavailable")
		}
		if strings.Contains(path, "?per_page=") {
			runners := append(slices.Clone(a.driver.runners), a.unrelated)
			return json.Unmarshal(jsonRelay(map[string]any{
				"total_count": len(runners), "runners": runners}), output)
		}
		if a.contradictory {
			return errors.New("NOT_FOUND")
		}
	}
	if method == "DELETE" && path == fmt.Sprintf("%s/%d", base, a.unrelated.ID) {
		panic("unrelated registration removed")
	}
	return a.driver.Call(method, path, input, output)
}

func TestE2EReplacementReadbackAndReplay(t *testing.T) {
	for _, kind := range []string{"unavailable", "contradictory", "lost-removal",
		"lost-adoption", "lost-activation", "wake", "peer", "provider",
		"wake-unavailable", "wake-contradictory"} {
		t.Run(kind, func(t *testing.T) {
			d := newRebuildDriver(t)
			api := &e2eReplacementAPI{driver: d,
				unrelated: RunnerInfo{ID: 99, Name: "unrelated", Status: "online"}}
			original := api.unrelated
			api.unavailable = kind == "unavailable"
			api.contradictory = kind == "contradictory"
			d.lostRemoval = kind == "lost-removal"
			d.lostAdoption = kind == "lost-adoption"
			d.lostActivation = kind == "lost-activation"
			if kind == "wake" || kind == "peer" {
				d.failure = kind
			}
			var out bytes.Buffer
			observer := newE2EReplacementObserver(t)
			wakeReadback := kind
			provider := "absent"
			providerWrites := 0
			login := filepath.Join(t.TempDir(), "original-login")
			delivery := filepath.Join(t.TempDir(), "delivery")
			sentinel := []byte("fixture original store sentinel")
			for _, path := range []string{login, delivery} {
				if err := os.WriteFile(path, sentinel, 0600); err != nil {
					t.Fatal(err)
				}
			}
			operations := func() rebuildOperations {
				ops := observer.operations(t, d, d.operations())
				setup := ops.host.setupAgent
				ops.host.setupAgent = func(p InitPlan, token []byte) error {
					if provider == "unknown" {
						return errors.New("provider readback unknown")
					}
					if provider == "done" {
						return nil
					}
					providerWrites++
					if err := setup(p, token); err != nil {
						return err
					}
					if kind == "provider" {
						provider = "unknown"
						return errors.New("fixture lost provider response")
					}
					provider = "done"
					return nil
				}
				activate := ops.host.activate
				ops.host.activate = func(p InitPlan, slots []sharedRegistration) (
					managedRelayResult, error) {
					result, err := activate(p, slots)
					state, readErr := observer.readHost()
					if readErr != nil {
						return managedRelayResult{}, readErr
					}
					if state.Wakes[p.Repository.ID] == 1 &&
						strings.HasPrefix(wakeReadback, "wake-") {
						return managedRelayResult{},
							errors.New("fixture wake readback " + wakeReadback)
					}
					return result, err
				}
				return ops
			}
			apply := func() error {
				out.Reset()
				return (App{API: api}).e2eApplyRebuild(
					d.api.data["repos/example/project"].(Repository),
					d.api.data["user"].(User), "claude", []byte("fixture-secret"),
					json.NewEncoder(&out), operations())
			}
			err := apply()
			if kind == "lost-removal" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil || strings.Contains(out.String(), "core_verified") {
					t.Fatal("uncertain observation reported success", err, out.String())
				}
				if kind == "provider" || kind == "unavailable" || kind == "contradictory" ||
					strings.HasPrefix(kind, "wake-") {
					if err := apply(); err == nil {
						t.Fatal("unresolved readback accepted")
					}
				}
				path, _ := sharedMutationPath()
				intent, err := readRebuildIntent(path)
				if err != nil || intent == nil {
					t.Fatal("recovery intent missing", err)
				}
				if kind == "unavailable" || kind == "contradictory" {
					e2eEqual(t, len(d.deletes), 0)
				}
				if kind == "provider" {
					e2eEqual(t, providerWrites, 1)
					e2eEqual(t, len(d.runners), 0)
					// Independent provider observation accounts for the original attempt.
					provider = "done"
				}
				wakeReadback = "observed"
				api.unavailable, api.contradictory, d.failure = false, false, ""
				if err := apply(); err != nil {
					t.Fatal(err, out.String())
				}
			}
			e2eEqual(t, d.deletes, []int64{25, 26})
			e2eEqual(t, len(d.runners), 2)
			e2eEqual(t, d.host.AdoptedRepositoryIDs, []int64{10, 11})
			if err := observer.completion(d); err != nil {
				t.Fatal(err)
			}
			e2eEqual(t, api.unrelated, original)
			e2eEqual(t, providerWrites, 1)

			for _, path := range []string{login, delivery} {
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				e2eEqual(t, data, sentinel)
			}
			if bytes.Contains(out.Bytes(), []byte("fixture-secret")) {
				t.Fatal("private provider input leaked")
			}
		})
	}
}
