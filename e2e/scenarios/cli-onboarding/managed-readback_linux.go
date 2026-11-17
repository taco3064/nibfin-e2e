//go:build linux

package cli

import (
	"strings"
)

// Assert provider/host inventory directly, without using the emitted handoff.
func (f *e2eManaged) readback(plan InitPlan) {
	f.t.Helper()
	base := "repos/" + plan.Repository.FullName
	repo := f.api.data[base].(Repository)
	e2eEqual(f.t, repo.ID, plan.Repository.ID)
	e2eEqual(f.t, repo.Owner.ID, f.binding.MemberID)
	pull := f.api.data[base+"/pulls/7"].(map[string]any)
	e2eEqual(f.t, pull["merged"], true)
	e2eEqual(f.t, pull["state"], "closed")
	e2eEqual(f.t, pull["number"], 7)
	intent := f.intent(plan)
	e2eEqual(f.t, pull["head"].(map[string]any)["sha"], intent.Head)
	e2eEqual(f.t, pull["head"].(map[string]any)["ref"],
		"nibfin/init-"+intent.Plan.Head[:12])
	e2eEqual(f.t, pull["base"].(map[string]any)["ref"], "main")
	e2eEqual(f.t, pull["head"].(map[string]any)["repo"],
		map[string]int64{"id": plan.Repository.ID})
	e2eEqual(f.t, pull["base"].(map[string]any)["repo"],
		map[string]int64{"id": plan.Repository.ID})
	for _, file := range plan.Files {
		stored := f.api.data[base+"/contents/"+file.Path+
			"?ref="+strings.Repeat("c", 40)].(Content)
		e2eEqual(f.t, stored, encoded([]byte(file.Content)))
	}
	wake := f.api.data[base+"/actions/variables/"+sharedPoolVariable].(actionsVariable)
	e2eEqual(f.t, wake.Value, "false")
	e2eEqual(f.t, f.services, map[string]string{
		"slot-1": "active", "slot-2": "active",
	})
	e2eEqual(f.t, f.host.MemberID, f.binding.MemberID)
	e2eEqual(f.t, f.host.Repository, f.binding.Repositories[0])
	e2eEqual(f.t, f.host.RepositoryID, int64(10))
	e2eEqual(f.t, f.host.adoptionStatus(plan.Repository.ID), "observed")
	e2eEqual(f.t, len(f.host.Runners), 2)
	for i, runner := range f.host.Runners {
		e2eEqual(f.t, runner.ID, f.slots[i].ID)
		e2eEqual(f.t, runner.Name, f.slots[i].Name)
	}
	inventory := f.api.data["repos/"+f.binding.Repositories[0]+
		"/actions/runners?per_page=100&page=1"].(map[string]any)
	e2eEqual(f.t, inventory["total_count"], 2)
	runners := inventory["runners"].([]RunnerInfo)
	e2eEqual(f.t, len(runners), 2)
	for i, runner := range runners {
		e2eEqual(f.t, runner.ID, f.slots[i].ID)
		e2eEqual(f.t, runner.Name, f.slots[i].Name)
		e2eEqual(f.t, runner.Status, "online")
	}
}
