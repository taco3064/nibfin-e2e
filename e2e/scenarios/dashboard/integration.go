package cli

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/taco3064/gh-nibfin/internal/pause"
	"github.com/taco3064/gh-nibfin/internal/snapshot"
)

func TestE2EDashboardOverview(t *testing.T) {
	f := e2eFacts(t)
	for _, mode := range f.Observations {
		t.Run(mode, func(t *testing.T) {
			p := &e2eDashboardProcess{t: t, mode: mode}
			o := dashboardObserver{process: p, subject: f.Subject, resolve: e2eResolve}
			local := o.Observe()
			if local.Status != "observed" {
				t.Fatal(mode, local)
			}
			counts := map[string]int{"zero": 0, "one": 1, "two": 2, "four": 4,
				"dedup": 2}
			count, ok := counts[mode]
			if !ok {
				count = 1
			}
			if len(local.Runners) != count {
				t.Fatal(mode, len(local.Runners))
			}
			idle := mode == "one" || mode == "two" || mode == "four" || mode == "dedup"
			if idle {
				e2eAssertIdleRunners(t, "Core/CLI observation", local.Runners, count)
			}
			work := local.Work[0]
			if work.Issue.ID != f.Identity.ID {
				t.Fatal("Issue binding lost", work)
			}
			switch mode {
			case "zero", "one", "two", "four", "dedup":
				if work.Activity.Value != nil || work.Waiting.Value == nil ||
					*work.Waiting.Value != "no-admission-observed" {
					t.Fatal("assignment became queue entry", work)
				}
			case "busy", "stale":
				if local.Runners[0].State != "busy" || work.Native != nil ||
					work.Phase.Value != nil {
					t.Fatal("unverified execution", work)
				}
			case "running", "stage", "collision":
				stage := "deliver"
				if mode == "stage" {
					stage = "accept"
				}
				if work.Native == nil || work.Native.Attempt != 1 ||
					work.Native.JobID != 200 || work.Phase.Value == nil ||
					*work.Phase.Value != stage {
					t.Fatal("execution lost", work)
				}
			case "offline":
				if local.Runners[0].State != "offline" {
					t.Fatal(local.Runners)
				}
			case "queued":
				if work.Activity.Value == nil || *work.Activity.Value != "queued" ||
					work.Phase.Value != nil {
					t.Fatal("queue conflated", work)
				}
			case "paused":
				if work.Pause.Value == nil || !*work.Pause.Value {
					t.Fatal(work)
				}
			case "blocked":
				if work.Dependencies.Value == nil || *work.Dependencies.Value != 1 {
					t.Fatal(work)
				}
			case "unknown":
				if work.ExecutionBlocker.Code != "RUNTIME_UNKNOWN" ||
					work.Waiting.Value != nil {
					t.Fatal(work)
				}
			}
			api := &e2eDashboardAPI{facts: f}
			view := (snapshot.OverviewProvider{Provider: snapshot.Provider{API: api},
				Subject: f.Subject, Observer: o}).CollectOverview()
			if mode != "zero" && len(view.Issues.Items) == 0 {
				t.Fatal("native overview integration missing", view)
			}
			if mode == "dedup" && len(view.Runners.Items) != 1 {
				t.Fatal("shared registration counted twice", view.Runners)
			}
			if idle {
				projectedCount := count
				if mode == "dedup" {
					projectedCount = 1
				}
				e2eAssertIdleRunners(t, "overview projection", view.Runners.Items,
					projectedCount)
			}
			if mode == "collision" {
				if len(view.Issues.Items) != 2 {
					t.Fatal(view.Issues)
				}
				foreign := view.Issues.Items[1]
				if foreign.NodeID != "I_foreign" || len(foreign.Evidence) != 1 ||
					foreign.Evidence[0].Native != nil {
					t.Fatal("cross-repo leak", foreign)
				}
			}
		})
	}
}

func e2eAssertIdleRunners(t *testing.T, boundary string,
	runners []snapshot.LocalRunner, count int) {
	t.Helper()
	if len(runners) != count {
		t.Fatalf("%s: expected %d idle registrations, got %d", boundary,
			count, len(runners))
	}
	for _, runner := range runners {
		if runner.State != "idle" {
			t.Fatalf("%s: runner %s: expected idle, got %s", boundary,
				runner.Key, runner.State)
		}
	}
}

func TestE2EDashboardDiagnosis(t *testing.T) {
	f := e2eFacts(t)
	for _, mode := range f.Diagnoses {
		t.Run(mode, func(t *testing.T) {
			api := &e2eDashboardAPI{facts: f}
			p := &e2eDashboardProcess{t: t, mode: mode, api: api}
			d := dashboardDiagnoser{api: api, process: p, subject: f.Subject,
				resolve: e2eResolve}
			out := d.Diagnose(context.Background(), e2eSelection(f), f.Attempt,
				mode == "capacity")
			want := map[string]string{"confirmed": "reported", "attributed": "reported",
				"missing": "insufficient-evidence", "denied": "denied",
				"capacity": "no-capacity", "unavailable": "unavailable",
				"stale-report": "denied"}[mode]
			if out.Status != want {
				t.Fatal(mode, out)
			}
			if mode == "confirmed" {
				if len(out.Reports) != 1 {
					t.Fatal(out)
				}
				r := out.Reports[0]
				if r.Binding.AdmissionID != f.Attempt.ID || r.Binding.Issue.ID !=
					f.Identity.ID || r.Current || r.Termination == nil ||
					r.Termination.OOMKilled == nil || !*r.Termination.OOMKilled {
					t.Fatal("confirmed cause detached from attempt", r)
				}
				if len(r.Missing) == 0 {
					t.Fatal("evidence gaps hidden", r)
				}
			}
			if mode == "attributed" {
				if len(out.Reports) != 1 || out.Reports[0].Confidence != "attributed" ||
					out.Reports[0].RootCause == nil || out.Reports[0].Current {
					t.Fatal("Agent explanation promoted or lost", out)
				}
			}
			data, _ := json.Marshal(out)
			if strings.Contains(string(data), "synthetic-dashboard") ||
				strings.Contains(string(data), "private failure") {
				t.Fatal("private transport leaked")
			}
			for _, changed := range []string{"subject", "repository", "node"} {
				api.changed = changed
				before := p.requests
				out = d.Diagnose(context.Background(), e2eSelection(f), f.Attempt, true)
				if mode != "unavailable" && (out.Status != "denied" ||
					p.requests != before) {
					t.Fatal("changed identity invoked Core", changed, out)
				}
			}
		})
	}
}

func TestE2EDashboardPause(t *testing.T) {
	f := e2eFacts(t)
	api := &e2eDashboardAPI{facts: f}
	p := &e2eDashboardProcess{t: t, api: api}
	c := e2ePause(api, p)
	target := pause.Target{RepositoryID: f.Identity.RepositoryID,
		IssueID: f.DatabaseID, Number: f.Identity.Number}
	for _, action := range []pause.Action{pause.Pause, pause.Resume} {
		r := pause.Request{Repository: f.Identity.Repository, Action: action,
			Targets: []pause.Target{target}}
		selected := c.Review(context.Background(), r)
		result := c.Apply(context.Background(), selected)
		label := "present"
		if action == pause.Resume {
			label = "absent"
		}
		if len(result) != 1 || result[0].Target != target ||
			result[0].Submission != "Requested" || result[0].Label != label ||
			result[0].Verdict != "Unknown" {
			t.Fatal(result)
		}
	}
	r := pause.Request{Repository: f.Identity.Repository, Action: pause.Pause,
		Targets: []pause.Target{target}}
	s := c.Review(context.Background(), r)
	api.changed = "subject"
	before := p.edits
	result := c.Apply(context.Background(), s)
	if p.edits != before || result[0].Reason != "identity_changed" {
		t.Fatal(result)
	}
	api.changed = ""
	p.ambiguous = true
	result = c.Apply(context.Background(), c.Review(context.Background(), r))
	if result[0].Submission != "Unknown" || result[0].Verdict != "Unknown" {
		t.Fatal("unknown external effect resolved without evidence", result)
	}
}

func TestE2EDashboardArguments(t *testing.T) {
	for _, args := range [][]string{{"--overview", "extra"},
		{"--overview", "--repo", "example/project"}, {"--overview=invalid"}} {
		if (App{}).Run(append([]string{"dashboard"}, args...), io.Discard) == nil {
			t.Fatal("public argument refusal lost", args)
		}
	}
}
