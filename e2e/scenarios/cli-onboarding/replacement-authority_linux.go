//go:build linux

package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

func TestE2EReplacementRemovalAuthority(t *testing.T) {
	for _, kind := range []string{"permission", "retirement", "runner"} {
		t.Run(kind, func(t *testing.T) {
			d := newRebuildDriver(t)
			var out bytes.Buffer
			repo := d.api.data["repos/example/project"].(Repository)
			user := d.api.data["user"].(User)
			apply := func(ops rebuildOperations) error {
				return (App{API: d}).e2eApplyRebuild(repo, user, "claude",
					[]byte("fixture-secret"), json.NewEncoder(&out), ops)
			}
			ops := d.operations()
			snapshot := ops.snapshot
			ops.snapshot = func() (rebuildSnapshot, error) {
				if len(d.deletes) == 1 {
					return rebuildSnapshot{}, errors.New("fixture invocation lost")
				}
				return snapshot()
			}
			if err := apply(ops); err == nil {
				t.Fatal("first removal did not interrupt")
			}
			path, err := sharedMutationPath()
			if err != nil {
				t.Fatal(err)
			}
			intent, err := readRebuildIntent(path)
			if err != nil || intent == nil {
				t.Fatal("missing intent", err)
			}
			originalID := intent.RetirementID
			// Discard the previous ports; re-entry must obtain fresh permission
			// and independently match both the retirement and remaining slot.
			ops = d.operations()
			core := ops.core
			ops.core = func(operation string) ([]byte, error) {
				data, err := core(operation)
				var response rebuildRetirementResult
				if json.Unmarshal(data, &response) != nil {
					t.Fatal("invalid fixture response")
				}
				switch kind {
				case "permission":
					response.Removal.Permitted = false
				case "retirement":
					response.ID = "99999999-1234-1234-1234-123456789abc"
				case "runner":
					response.Removal.Runners[1].Name = "unrelated"
				}
				return jsonRelay(response), err
			}
			for range 2 {
				out.Reset()
				if err := apply(ops); err == nil {
					t.Fatal("saved phase authorized unmatched current removal")
				}
				e2eEqual(t, d.deletes, []int64{25})
				e2eEqual(t, e2eReplacementIDs(d), []int64{26})
				if bytes.Contains(out.Bytes(), []byte("core_verified")) {
					t.Fatal("unverified authority reported completion")
				}
				intent, err = readRebuildIntent(path)
				if err != nil || intent == nil {
					t.Fatal("lost intent", err)
				}
				e2eEqual(t, intent.RetirementID, originalID)
			}
			if err := apply(d.operations()); err != nil {
				t.Fatal(err)
			}
			e2eEqual(t, d.deletes, []int64{25, 26})
			e2eEqual(t, e2eReplacementIDs(d), []int64{31, 32})
		})
	}
}
