//go:build linux

package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
)

// This disposable backend owns synthetic host effects separately from replies.
// Observers reopen its persisted state; invocation closures own no host state.
type e2eReplacementHostState struct {
	Services  map[int64]bool
	Adoptions map[int64]e2eReplacementAdoption
	Wakes     map[int64]int
}

func (o *e2eReplacementObserver) readHost() (e2eReplacementHostState, error) {
	var state e2eReplacementHostState
	data, err := os.ReadFile(o.HostState)
	if err != nil {
		return state, err
	}
	err = json.Unmarshal(data, &state)
	return state, err
}

func (o *e2eReplacementObserver) writeHost(t *testing.T,
	state e2eReplacementHostState) {
	t.Helper()
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(o.HostState, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func (o *e2eReplacementObserver) changeHost(t *testing.T,
	change func(*e2eReplacementHostState)) {
	t.Helper()
	state, err := o.readHost()
	if err != nil {
		t.Fatal(err)
	}
	change(&state)
	o.writeHost(t, state)
}

func (o *e2eReplacementObserver) observeAdoption(t *testing.T,
	d *rebuildDriver, repository int64) {
	t.Helper()
	// Read the adopted host's own slots, not the provider registration inventory.
	if d.host.Agent == nil || sameRebuildPool(&d.old, d.host) ||
		!slices.Contains(d.host.AdoptedRepositoryIDs, repository) {
		return
	}
	o.changeHost(t, func(state *e2eReplacementHostState) {
		if o.Fault == "adoption-missing" {
			return
		}
		ids := []int64{}
		for _, runner := range d.host.Runners {
			ids = append(ids, runner.ID)
		}
		agent := *d.host.Agent
		if o.Fault == "adoption-contradictory" {
			agent.Provider = "codex"
		}
		state.Adoptions[repository] = e2eReplacementAdoption{ids, agent}
	})
}

func (o *e2eReplacementObserver) hostOperations(t *testing.T, d *rebuildDriver,
	ops rebuildOperations) rebuildOperations {
	t.Helper()
	core := ops.core
	ops.core = func(operation string) ([]byte, error) {
		// A controlled cleanup effect, independent of the Core reply or phase.
		// Actual Core cleanup decisions are exercised by replacement-core.mjs.
		ids := e2eReplacementIDs(d)
		if !slices.Contains(ids, int64(25)) && !slices.Contains(ids, int64(26)) {
			o.changeHost(t, func(state *e2eReplacementHostState) {
				state.Services[25], state.Services[26] = false, false
			})
		}
		return core(operation)
	}
	adopt := ops.host.adopt
	ops.host.adopt = func(p InitPlan, slots []sharedRegistration) (*sharedHost, error) {
		host, err := adopt(p, slots)
		o.observeAdoption(t, d, p.Repository.ID)
		return host, err
	}
	peer := ops.host.adoptPeer
	ops.host.adoptPeer = func(h sharedHost, p InitPlan) error {
		err := peer(h, p)
		o.observeAdoption(t, d, p.Repository.ID)
		return err
	}
	// Upstream start/wake fixtures only return replies. Replace those no-op ports
	// with controlled effects, rather than inventing observations from nil errors.
	ops.host.start = func(paths []string) error {
		d.calls = append(d.calls, "start")
		o.Effects = append(o.Effects, e2eReplacementEffect{Kind: "start"})
		if d.failure == "start" {
			return errors.New("synthetic start interruption")
		}
		o.changeHost(t, func(state *e2eReplacementHostState) {
			for n, path := range paths {
				if n >= len(d.host.Runners) || !slices.Contains(d.paths, path) {
					t.Fatal("unmatched service path")
				}
				id := d.host.Runners[n].ID
				if o.Fault != "service-missing" {
					state.Services[id] = o.Fault != "service-contradictory"
				}
			}
		})
		return nil
	}
	ops.host.activate = func(p InitPlan, slots []sharedRegistration) (
		managedRelayResult, error) {
		d.calls = append(d.calls, "wake")
		if d.failure == "wake" {
			return managedRelayResult{}, errors.New("synthetic wake interruption")
		}
		o.changeHost(t, func(state *e2eReplacementHostState) {
			// The controlled wake endpoint reconciles a prior delivered wake.
			if o.Fault != "wake-missing" && state.Wakes[p.Repository.ID] == 0 {
				state.Wakes[p.Repository.ID]++
			}
			if o.Fault == "wake-contradictory" {
				state.Wakes[p.Repository.ID] = 2
			}
		})
		return managedRelayResult{Github: "verified", Control: "resumed"}, nil
	}
	return ops
}

func TestE2EReplacementHostReadback(t *testing.T) {
	for _, fault := range []string{"service-missing", "service-contradictory",
		"adoption-missing", "adoption-contradictory", "wake-missing",
		"wake-contradictory"} {
		t.Run(fault, func(t *testing.T) {
			d := newRebuildDriver(t)
			o := newE2EReplacementObserver(t)
			o.Fault = fault
			var out bytes.Buffer
			err := (App{API: e2eObservedReplacementAPI{d, o}}).e2eApplyRebuild(
				d.api.data["repos/example/project"].(Repository),
				d.api.data["user"].(User), "claude", []byte("fixture-secret"),
				json.NewEncoder(&out), o.operations(t, d, d.operations()))
			if err != nil || !strings.Contains(out.String(),
				"MANAGED_REPLACEMENT_ACTIVE") {
				t.Fatal("fault must accompany successful CLI replies", err, out.String())
			}
			if err := o.completion(d); err == nil ||
				!strings.Contains(err.Error(), strings.Split(fault, "-")[0]) {
				t.Fatal("successful reply concealed missing/contradictory effect", err)
			}
			// Reopening the backend from a fresh observer cannot promote the reply.
			reloaded := &e2eReplacementObserver{HostState: o.HostState}
			if err := reloaded.completion(d); err == nil {
				t.Fatal("reconstructed observer lost host discrepancy")
			}
		})
	}
}
