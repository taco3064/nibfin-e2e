//go:build linux

package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The upstream driver supplies only controlled ports. These repository-owned
// assertions use registration and host observations independently of CLI output.
func TestE2EReplacementRecovery(t *testing.T) {
	d := newRebuildDriver(t)
	observer := newE2EReplacementObserver(t)
	var out bytes.Buffer
	ops := observer.operations(t, d, d.operations())
	snapshot := ops.snapshot
	removals := 0
	ops.snapshot = func() (rebuildSnapshot, error) {
		if len(d.deletes) == 1 && removals == 0 {
			removals++
			return rebuildSnapshot{}, errors.New("fixture invocation interrupted")
		}
		return snapshot()
	}
	app := App{API: e2eObservedReplacementAPI{d, observer}}
	repo := d.api.data["repos/example/project"].(Repository)
	user := d.api.data["user"].(User)
	apply := func(ops rebuildOperations) error {
		return app.applyRebuild(repo, user, "claude", []byte("fixture-secret"),
			json.NewEncoder(&out), ops)
	}
	if err := apply(ops); err == nil {
		t.Fatal("first removal interruption was not observed")
	}
	e2eEqual(t, d.deletes, []int64{25})
	e2eEqual(t, len(d.runners), 1)
	e2eEqual(t, d.runners[0].ID, int64(26))
	path, err := sharedMutationPath()
	if err != nil {
		t.Fatal(err)
	}
	intent, err := readRebuildIntent(path)
	if err != nil || intent == nil || intent.RetirementID != fixtureRetirementID {
		t.Fatal("durable retirement identity missing", err)
	}
	// Save independent fixture records, discard the old instance and its closures.
	observation := struct {
		Host       *sharedHost
		Retirement *rebuildRetirement
		Runners    []RunnerInfo
		Deletes    []int64
		Paths      []string
		Observer   *e2eReplacementObserver
	}{d.host, d.retirement, d.runners, d.deletes, d.paths, observer}
	file := filepath.Join(t.TempDir(), "observations.json")
	data, err := json.Marshal(observation)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, apply = nil, nil
	observation.Host, observation.Retirement = nil, nil
	observation.Observer, observer = nil, nil
	restored, err := os.ReadFile(file)
	if err != nil || json.Unmarshal(restored, &observation) != nil {
		t.Fatal("fixture observation reload failed", err)
	}
	next := &rebuildDriver{api: d.api, old: intent.Old,
		host: observation.Host, retirement: observation.Retirement,
		runners: observation.Runners, deletes: observation.Deletes,
		paths: observation.Paths, repositories: intent.Repositories,
		binding: intent.Agent}
	d, ops, app = nil, rebuildOperations{}, App{}
	observer = observation.Observer
	out.Reset()
	err = (App{API: e2eObservedReplacementAPI{next, observer}}).applyRebuild(
		repo, user, "claude", []byte("fixture-secret"), json.NewEncoder(&out),
		observer.operations(t, next, next.operations()))
	if err != nil {
		t.Fatal(err, out.String())
	}
	e2eEqual(t, next.deletes, []int64{25, 26})
	e2eEqual(t, len(next.runners), 2)
	e2eEqual(t, next.host.AdoptedRepositoryIDs, []int64{10, 11})
	e2eEqual(t, *next.host.Agent, intent.Agent)
	e2eEqual(t, next.retirement.ID, intent.RetirementID)
	e2eEqual(t, next.retirement.Release, "released")
	observer.verify(t, next)
	ids := []int64{}
	for _, runner := range next.runners {
		if slices.Contains([]int64{25, 26}, runner.ID) || slices.Contains(ids, runner.ID) {
			t.Fatal("old or duplicate replacement identity", next.runners)
		}
		ids = append(ids, runner.ID)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	record := map[string]any{"old": []int64{25, 26}, "fresh": ids,
		"repositories": next.host.AdoptedRepositoryIDs, "provider": next.host.Agent.Provider,
		"recovery": "reconstructed", "removals": next.deletes,
		"retirementId": intent.RetirementID}
	// No CLI result document is used to construct this fixture observation.
	if err := os.WriteFile(filepath.Join(home, "replacement-observations.json"),
		jsonRelay(record), 0600); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "MANAGED_REPLACEMENT_ACTIVE") {
		t.Fatal("replacement did not complete", out.String())
	}
}

func TestE2EReplacementUnknownProvider(t *testing.T) {
	d := newRebuildDriver(t)
	var out bytes.Buffer
	calls := 0
	observed := "absent"
	operations := func() rebuildOperations {
		ops := d.operations()
		ops.host.setupAgent = func(InitPlan, []byte) error {
			if observed == "absent" {
				calls++
				observed = "unknown"
			}
			return errors.New("fixture provider effect unknown")
		}
		return ops
	}
	for range 2 {
		err := (App{API: d}).applyRebuild(
			d.api.data["repos/example/project"].(Repository),
			d.api.data["user"].(User), "claude", []byte("fixture-secret"),
			json.NewEncoder(&out), operations())
		if err == nil {
			t.Fatal("unknown provider effect completed")
		}
	}
	// An unresolved effect cannot authorize a second provider mutation. The
	// operation closure was reconstructed; independent provider readback owns it.
	e2eEqual(t, calls, 1)
	e2eEqual(t, len(d.runners), 0)
	if strings.Contains(out.String(), "MANAGED_REPLACEMENT_ACTIVE") {
		t.Fatal("unknown provider effect reported activation")
	}
}
