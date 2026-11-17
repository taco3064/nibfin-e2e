//go:build linux

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestE2EManagedPreview(t *testing.T) {
	f := e2eManagedFixture(t)
	var out bytes.Buffer
	err := (App{API: f.transport, Process: e2eNoProcess{t}}).Run([]string{
		"init", "--repo", f.plan.Repository.FullName,
		"--execution-repo", f.plan.Repository.FullName}, &out)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Status string   `json:"status"`
		Plan   InitPlan `json:"plan"`
	}
	if json.Unmarshal(out.Bytes(), &result) != nil || result.Status != "preview" {
		t.Fatal("missing preview")
	}
	e2eEqual(t, result.Plan, f.plan)
	e2eEqual(t, len(f.api.writes), 0)
	e2eEqual(t, len(f.counts), 0)
	e2eEqual(t, len(f.slots), 0)
	if f.host != nil || managedIntentAvailable(f.plan.Repository) {
		t.Fatal("preview created host or intent")
	}
}

func TestE2EManagedProposalReadback(t *testing.T) {
	for _, kind := range []string{"open", "identity", "head", "base", "closed",
		"caller", "unresolved-provider"} {
		t.Run(kind, func(t *testing.T) {
			f := e2eManagedFixture(t)
			intent := f.open(f.plan)
			e2eEqual(t, intent.Plan, f.plan)
			e2eEqual(t, intent.PR, 7)
			e2eEqual(t, intent.Head, strings.Repeat("b", 40))
			if kind == "open" {
				f.open(f.plan)
			} else {
				f.merge()
				code := "MANAGED_INSTALL_PR_CHANGED"
				switch kind {
				case "identity":
					f.pull["number"] = 8
				case "head":
					f.pull["head"].(map[string]any)["sha"] = strings.Repeat("d", 40)
				case "base":
					f.pull["base"].(map[string]any)["repo"] = map[string]int64{"id": 99}
				case "closed":
					f.pull["merged"] = false
					code = "MANAGED_INSTALL_PR_CLOSED_WITHOUT_MERGE"
				case "caller":
					path := "repos/" + f.plan.Repository.FullName + "/contents/" +
						f.plan.Files[0].Path + "?ref=" + strings.Repeat("c", 40)
					f.api.data[path] = encoded([]byte("changed caller bytes"))
					code = "MANAGED_INSTALL_PLAN_REQUIRES_READBACK"
				case "unresolved-provider":
					f.transport.wrote = true
					f.transport.hide = "repos/" + f.plan.Repository.FullName + "/pulls/7"
					code = "READ_BACK_UNAVAILABLE"
				}
				for range 2 {
					f.rejected(f.resume(context.Background(), f.plan), code)
				}
			}
			e2eEqual(t, f.intent(f.plan), intent)
			e2eEqual(t, len(f.api.writes), 0)
			e2eEqual(t, len(f.counts), 0)
			e2eEqual(t, len(f.slots), 0)
			if f.host != nil {
				t.Fatal("unconfirmed proposal adopted a host")
			}
			if kind == "unresolved-provider" {
				f.transport.hide = ""
				if err := f.resume(context.Background(), f.plan); err != nil {
					t.Fatal(err)
				}
				f.handoff(f.plan)
				e2eEqual(t, f.intent(f.plan), intent)
			}
		})
	}
}

func TestE2EManagedCredentialBoundary(t *testing.T) {
	for _, kind := range []string{"environment-only", "wrong-credential-member",
		"wrong-host-member"} {
		t.Run(kind, func(t *testing.T) {
			f := e2eManagedFixture(t)
			intent := f.open(f.plan)
			f.merge()
			code := "FIXTURE_MEMBER_BINDING_CHANGED"
			switch kind {
			case "environment-only":
				t.Setenv("GH_TOKEN", string(f.token))
				t.Setenv("GITHUB_TOKEN", string(f.token))
				if err := os.Remove(f.loginPath); err != nil {
					t.Fatal(err)
				}
				code = "FIXTURE_STORED_LOGIN_REQUIRED"
			case "wrong-credential-member":
				f.member = 99
			case "wrong-host-member":
				f.host = &sharedHost{SchemaVersion: 1,
					SharedExecution: *f.plan.Execution, MemberID: 99}
				data := []byte(`{"runners":[{"id":91,"name":"wrong-slot-1"},
					{"id":92,"name":"wrong-slot-2"}]}`)
				if err := json.Unmarshal(data, f.host); err != nil {
					t.Fatal(err)
				}
				code = "MANAGED_INSTALL_HOST_BINDING_CHANGED"
			}
			f.rejected(f.resume(context.Background(), f.plan), code)
			e2eEqual(t, f.counts["register"], 0)
			e2eEqual(t, f.counts["stage"], 0)
			e2eEqual(t, f.counts["adopt"], 0)
			e2eEqual(t, len(f.slots), 0)
			e2eEqual(t, f.intent(f.plan), intent)
			// Independent fixture reconciliation restores the original member/login.
			f.member, f.host = f.binding.MemberID, nil
			if err := os.WriteFile(f.loginPath, f.token, 0600); err != nil {
				t.Fatal(err)
			}
			if err := f.resume(context.Background(), f.plan); err != nil {
				t.Fatal(err)
			}
			f.handoff(f.plan)
		})
	}
}

func (f *e2eManaged) handoff(plan InitPlan) {
	f.t.Helper()
	f.readback(plan)
	var result struct {
		Status     string               `json:"status"`
		Code       string               `json:"code"`
		Wake       string               `json:"wake"`
		Member     int64                `json:"member_id"`
		Repository int64                `json:"repository_id"`
		Execution  SharedExecution      `json:"execution"`
		Runners    []sharedRegistration `json:"runners"`
	}
	lines := bytes.Split(bytes.TrimSpace(f.out.Bytes()), []byte("\n"))
	if json.Unmarshal(lines[len(lines)-1], &result) != nil {
		f.t.Fatal("missing handoff")
	}
	e2eEqual(f.t, result.Status, "completed")
	e2eEqual(f.t, result.Code, "MANAGED_INSTALLATION_INACTIVE")
	e2eEqual(f.t, result.Wake, "inactive")
	e2eEqual(f.t, result.Member, f.member)
	e2eEqual(f.t, result.Repository, plan.Repository.ID)
	e2eEqual(f.t, result.Execution, f.host.SharedExecution)
	e2eEqual(f.t, result.Runners, f.slots)
	if len(f.slots) != 2 || f.slots[0].ID == f.slots[1].ID ||
		f.slots[0].ID <= 0 || f.slots[1].ID <= 0 || bytes.Contains(f.out.Bytes(), f.token) {
		f.t.Fatal("invalid pair or unredacted output")
	}
	if _, err := os.Stat(f.secretPath); !os.IsNotExist(err) {
		f.t.Fatal("fixture credentials retained after confirmed handoff", err)
	}
	e2eEqual(f.t, len(f.api.writes), 0)
}

func TestE2EManagedResumeAndPeer(t *testing.T) {
	f := e2eManagedFixture(t)
	intent := f.open(f.plan)
	f.merge()
	f.interrupt = true
	f.rejected(f.resume(context.Background(), f.plan), "FIXTURE_START_INTERRUPTED")
	e2eEqual(t, f.intent(f.plan), intent)
	e2eEqual(t, f.slots[0].Status, "online")
	e2eEqual(t, f.slots[1].Status, "offline")
	e2eEqual(t, f.services, map[string]string{
		"slot-1": "active", "slot-2": "inactive",
	})
	if data, err := os.ReadFile(f.secretPath); err != nil || !bytes.Equal(data, f.token) {
		t.Fatal("recovery material removed before readback", err)
	}
	for range 2 {
		if err := f.resume(context.Background(), f.plan); err != nil {
			t.Fatal(err)
		}
		f.handoff(f.plan)
	}
	pair := append([]sharedRegistration(nil), f.slots...)
	peer := f.peer()
	peerIntent := f.open(peer)
	_, merge := f.proposal(peer)
	merge()
	for range 2 {
		if err := f.resume(context.Background(), peer); err != nil {
			t.Fatal(err)
		}
		f.handoff(peer)
	}
	e2eEqual(t, f.slots, pair)
	e2eEqual(t, f.host.AdoptedRepositoryIDs, []int64{10, 20})
	e2eEqual(t, f.intent(f.plan), intent)
	e2eEqual(t, f.intent(peer), peerIntent)
	for _, name := range []string{"prepare", "stage", "register", "adopt", "peer"} {
		e2eEqual(t, f.counts[name], 1)
	}
	e2eEqual(t, f.counts["start"], 2)
	e2eEqual(t, f.counts["staged"], 1)
}

func (f *e2eManaged) peer() InitPlan {
	f.t.Helper()
	peer := f.plan.Repository
	peer.ID, peer.FullName = 20, f.binding.Repositories[1]
	base := "repos/" + peer.FullName
	f.api.data[base] = peer
	ref := reference{Ref: "refs/heads/main"}
	ref.Object.SHA = strings.Repeat("d", 40)
	f.api.data[base+"/git/ref/heads/main"] = ref
	f.api.data["repos/"+f.plan.Repository.FullName+
		"/actions/workflows/shared-runner.yml"] = map[string]any{
		"id": 40, "path": sharedRunnerWorkflow, "state": "active",
	}
	for _, label := range []string{"scope", "shaped", "delivered"} {
		f.api.data[base+"/labels/"+label] = map[string]string{"name": label}
	}
	plan, err := planInitWithExecution(f.transport, peer.FullName,
		f.plan.Repository.FullName)
	if err != nil {
		f.t.Fatal(err)
	}
	f.proposal(plan)
	return plan
}

func TestE2EManagedUnresolvedEffects(t *testing.T) {
	f := e2eManagedFixture(t)
	intent := f.open(f.plan)
	f.merge()
	f.interrupt = true
	f.rejected(f.resume(context.Background(), f.plan), "FIXTURE_START_INTERRUPTED")
	// Discovery cannot account for a host effect. No retry may register/adopt again.
	f.unresolved = true
	for range 2 {
		f.rejected(f.resume(context.Background(), f.plan), "FIXTURE_HOST_EFFECT_UNRESOLVED")
	}
	e2eEqual(t, f.counts["register"], 1)
	e2eEqual(t, f.counts["adopt"], 1)
	e2eEqual(t, f.counts["start"], 1)
	e2eEqual(t, len(f.slots), 2)
	e2eEqual(t, f.counts["cleanup"], 0)
	e2eEqual(t, f.intent(f.plan), intent)
	// Independent records account for the original host and partial start.
	f.unresolved = false
	if err := f.resume(context.Background(), f.plan); err != nil {
		t.Fatal(err)
	}
	f.handoff(f.plan)
	e2eEqual(t, f.counts["register"], 1)
	e2eEqual(t, f.counts["adopt"], 1)
}
