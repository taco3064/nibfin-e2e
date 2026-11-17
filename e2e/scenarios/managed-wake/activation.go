//go:build linux

package cli

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

// Reuse producer transport helpers, but execute and assert our own activation.
func TestE2EManagedWakeActivation(t *testing.T) {
	for _, scenario := range []string{"configured", "legacy", "lost-readback"} {
		t.Run(scenario, func(t *testing.T) {
			d := newRelayDriver(t)
			recipes, err := os.ReadFile(os.Getenv("E2E_RECIPES"))
			if err != nil {
				t.Fatal(err)
			}
			pin := Pins().Core
			d.api.data["repos/"+pin.Repository+"/contents/src/caller-recipes.json?ref="+
				pin.Commit] = encoded(recipes)
			workflow, err := os.ReadFile(os.Getenv("E2E_SHARED_WORKFLOW"))
			if err != nil {
				t.Fatal(err)
			}
			d.plan.Execution = &SharedExecution{"example/execution", 20}
			destinationRepo := d.plan.Repository
			destinationRepo.ID, destinationRepo.FullName = 20, "example/execution"
			destinationRepo.Owner = d.plan.Member
			base := "repos/example/execution"
			d.api.data[base] = destinationRepo
			d.api.data[base+"/branches/main"] = map[string]any{
				"name": "main", "protected": true,
				"commit": map[string]string{"sha": strings.Repeat("b", 40)},
			}
			head := strings.Repeat("b", 40)
			d.api.data[base+"/actions/workflows/shared-runner.yml"] = map[string]any{
				"id": 42, "path": sharedRunnerWorkflow, "state": "active",
			}
			d.api.data[base+"/contents/"+sharedRunnerWorkflow+"?ref="+head] = encoded(workflow)
			d.snapshot.Bindings = nil
			d.addAdoption(10, "example/project", 40)
			initial := string(d.snapshot.Bindings)
			slots := []map[string]any{
				{"id": 400, "name": "simulation-slot-1", "memberId": 7},
				{"id": 401, "name": "simulation-slot-2", "memberId": 7},
			}
			if scenario == "legacy" {
				d.api.data["repos/example/project/actions/secrets/NIBFIN_WAKE_TOKEN"] =
					map[string]string{"name": "NIBFIN_WAKE_TOKEN"}
			}
			before, _ := json.Marshal(slots)
			ops := d.operations()
			check := ops.recheck
			ops.recheck = func() error {
				if err := check(); err != nil {
					return err
				}
				current, _ := json.Marshal(slots)
				if string(before) != string(current) {
					return errors.New("simulation Runner identity changed")
				}
				return verifySharedExecutionWorkflow(d.api, destinationRepo, workflow)
			}
			if scenario == "lost-readback" {
				local := ops.local
				ops.local = func(request relayLocalRequest) ([]byte, error) {
					if request.Operation == "read" && len(d.config.Origins) > 0 {
						return jsonRelay(relayLocalSnapshot{}), nil
					}
					return local(request)
				}
			}
			result, err := configureManagedRelay(relayVariableAPI{d}, d.plan, ops)
			if scenario != "configured" {
				if err == nil || d.enabled || strings.Contains(strings.Join(d.calls, ","),
					"resume") {
					t.Fatal("unsafe activation", err, d.calls)
				}
				return
			}
			if err != nil || result.Mode != "managed" || result.DispatchObserved ||
				!d.enabled || d.paused || string(d.snapshot.Bindings) != initial {
				t.Fatal("activation did not preserve matched inactive installation", err)
			}
			sequence := strings.Join(d.calls, ",")
			enable := "enable --now nibfin-notification-relay.timer,resume"
			if !strings.Contains(sequence, "write,read,prepare,daemon-reload,inspect") ||
				!strings.Contains(sequence, enable) {
				t.Fatal("activation ordering", sequence)
			}
			var stored relayConfiguration
			if json.Unmarshal(d.snapshot.Config, &stored) != nil ||
				!reflect.DeepEqual(stored, d.config) {
				t.Fatal("config readback")
			}
			destination := d.api.data["repos/example/project/actions/variables/"+
				sharedDestinationVariable].(actionsVariable)
			suppression := d.api.data["repos/example/project/actions/variables/"+
				sharedPoolVariable].(actionsVariable)
			if suppression.Value != "true" {
				t.Fatal("suppression readback")
			}
			t.Log("MANAGED_WAKE=" + string(jsonRelay(map[string]any{
				"config": stored, "bindings": d.snapshot.Bindings, "pin": pin,
				"destination": json.RawMessage(destination.Value), "slots": slots,
				"memberId": d.plan.Member.ID, "result": result, "calls": d.calls,
				"runner": map[string]any{
					"repository":   d.plan.Execution.Repository,
					"repositoryId": d.plan.Execution.RepositoryID,
					"workflowId":   42, "workflowPath": sharedRunnerWorkflow,
					"sourceCommit": head, "workflowBlob": blobHash(workflow),
					"memberId": d.plan.Member.ID,
				},
			})))
		})
	}
}
