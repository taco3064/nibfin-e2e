//go:build linux

package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
)

func (f *e2eManaged) nativeSlots() {
	labels := []struct {
		Name string `json:"name"`
	}{{"nibfin-user-7"}, {"nibfin-shared"}}
	runners := []RunnerInfo{}
	for _, slot := range f.slots {
		runners = append(runners, RunnerInfo{ID: slot.ID, Name: slot.Name,
			Status: slot.Status, OS: "Linux", Labels: labels})
	}
	f.api.data["repos/"+f.plan.Repository.FullName+
		"/actions/runners?per_page=100&page=1"] = map[string]any{
		"total_count": len(runners), "runners": runners,
	}
}

func (f *e2eManaged) operations() managedHostOperations {
	return managedHostOperations{
		discover: func() (*sharedHost, error) {
			f.counts["discover"]++
			if f.unresolved {
				return nil, errors.New("FIXTURE_HOST_EFFECT_UNRESOLVED")
			}
			if f.host == nil {
				return nil, nil
			}
			// Return a snapshot: callers cannot mutate independent host inventory.
			data, err := json.Marshal(f.host)
			if err != nil {
				return nil, err
			}
			return decodeSharedHost(data)
		},
		prepare: func(InitPlan) error { f.counts["prepare"]++; return nil },
		credentials: func(member int64, token []byte) error {
			f.counts["credentials"]++
			stored, err := os.ReadFile(f.loginPath)
			defer clear(stored)
			if err != nil || !bytes.Equal(stored, token) {
				return errors.New("FIXTURE_STORED_LOGIN_REQUIRED")
			}
			if member != f.member || !bytes.Equal(token, f.token) {
				return errors.New("FIXTURE_MEMBER_BINDING_CHANGED")
			}
			return nil
		},
		stage: func(InitPlan) ([]string, error) {
			f.counts["stage"]++
			if err := os.WriteFile(f.secretPath, f.token, 0600); err != nil {
				return nil, err
			}
			return []string{"simulation-slot-1", "simulation-slot-2"}, nil
		},
		register: func(_ InitPlan, paths []string) ([]sharedRegistration, error) {
			f.counts["register"]++
			if len(paths) != 2 || len(f.slots) != 0 {
				f.t.Fatal("duplicate registration or wrong slot inventory")
			}
			f.slots = []sharedRegistration{
				{ID: 11901, Name: "simulation-slot-1", Status: "offline"},
				{ID: 11902, Name: "simulation-slot-2", Status: "offline"},
			}
			f.nativeSlots()
			return append([]sharedRegistration(nil), f.slots...), nil
		},
		adopt: func(plan InitPlan, slots []sharedRegistration) (*sharedHost, error) {
			f.counts["adopt"]++
			e2eEqual(f.t, slots, f.slots)
			host := &sharedHost{SchemaVersion: 1, MemberID: f.member,
				SharedExecution:      *plan.Execution,
				AdoptedRepositoryIDs: []int64{plan.Repository.ID}}
			for _, slot := range f.slots {
				host.Runners = append(host.Runners, struct {
					ID   int64  `json:"id"`
					Name string `json:"name"`
				}{slot.ID, slot.Name})
			}
			f.host = host
			return host, nil
		},
		adoptPeer: func(host sharedHost, plan InitPlan) error {
			f.counts["peer"]++
			if !host.samePool(f.host) || plan.Repository.ID != 20 ||
				plan.Repository.FullName != f.binding.Repositories[1] {
				f.t.Fatal("peer adoption changed identity")
			}
			f.host.AdoptedRepositoryIDs = append(f.host.AdoptedRepositoryIDs, 20)
			return nil
		},
		staged: func(_ InitPlan, slots []sharedRegistration) ([]string, error) {
			f.counts["staged"]++
			e2eEqual(f.t, slots, f.slots)
			return nil, nil
		},
		start: func([]string) error {
			f.counts["start"]++
			f.services["slot-1"] = "active"
			f.services["slot-2"] = "inactive"
			f.slots[0].Status = "online"
			if f.interrupt {
				f.interrupt = false
				f.nativeSlots()
				return errors.New("FIXTURE_START_INTERRUPTED")
			}
			f.services["slot-2"] = "active"
			f.slots[1].Status = "online"
			f.nativeSlots()
			return nil
		},
		cleanup: func(_ InitPlan, slots []sharedRegistration) error {
			f.counts["cleanup"]++
			e2eEqual(f.t, slots, f.slots)
			if len(f.slots) != 2 || f.slots[0].Status != "online" ||
				f.slots[1].Status != "online" {
				f.t.Fatal("cleanup preceded confirmed online readback")
			}
			err := os.Remove(f.secretPath)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		},
	}
}
