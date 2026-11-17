//go:build linux

package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func e2eDesktopRun(t *testing.T, p *e2eDesktop, options ...string) (
	map[string]json.RawMessage, error,
) {
	t.Helper()
	// /dev/null can appear interactive to the CLI's character-device check.
	// A real empty regular file makes the no-consent case deterministic.
	stdin, err := os.CreateTemp(t.TempDir(), "stdin")
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdin
	os.Stdin = stdin
	defer func() { os.Stdin = original; stdin.Close() }()
	var out bytes.Buffer
	api := &e2eAPI{API: initFixture()}
	args := append([]string{"init", "--repo", "example/project"}, options...)
	err = (App{Process: p, API: api}).runDesktop(args, p.host, &out)
	if len(api.calls) != 0 {
		t.Fatal("desktop reached repository API", api.calls)
	}
	var plan map[string]json.RawMessage
	if json.Unmarshal(out.Bytes(), &plan) != nil {
		t.Fatal(out.String(), err)
	}
	if string(plan["protected_execution"]) != `"unverified"` {
		t.Fatal("controlled discovery claimed protection", out.String())
	}
	return plan, err
}

func TestE2EDesktopInventory(t *testing.T) {
	for _, host := range []string{"windows", "darwin"} {
		t.Run(host, func(t *testing.T) {
			scenarios := []string{"zero", "one", "multiple", "adopted", "explicit", "stopped"}
			if host == "windows" {
				scenarios = append(scenarios, "wsl1")
			}
			for _, scenario := range scenarios {
				t.Run(scenario, func(t *testing.T) {
					p := e2eDesktopFixture(t, host)
					selected := p.provider() + ":" + p.guests[0].name
					options := []string{}
					switch scenario {
					case "zero":
						p.guests = nil
						selected = ""
					case "multiple", "adopted", "explicit":
						other := *p.guests[0]
						other.name, other.identity = "Second", strings.Repeat("2", 32)
						p.guests = append(p.guests, &other)
						selected = ""
						if scenario == "adopted" {
							other.adopted = true
						}
						if scenario != "multiple" {
							selected = p.provider() + ":Second"
						}
						if scenario == "explicit" {
							options = []string{"--target", selected}
						}
					case "stopped":
						p.guests[0].running = false
					case "wsl1":
						p.guests[0].version, selected = 1, ""
					}
					plan, err := e2eDesktopRun(t, p, options...)
					if err != nil {
						t.Fatal(err)
					}
					var actual string
					if raw := plan["selected_target"]; raw != nil {
						if json.Unmarshal(raw, &actual) != nil {
							t.Fatal(string(raw))
						}
					}
					if actual != selected {
						t.Fatal("selection", actual, selected)
					}
					if selected == "" {
						expected := "NO_ELIGIBLE_LINUX_TARGET"
						if scenario == "multiple" {
							expected = "SELECT_TARGET_WITH_TARGET_OPTION"
						}
						if string(plan["selection"]) != `"`+expected+`"` {
							t.Fatal("missing selection diagnostic", plan)
						}
					}
					p.noEffects()
					if scenario == "wsl1" {
						_, err := e2eDesktopRun(t, p, "--apply", "--consent-open-target",
							"--target", "wsl:Ubuntu Dev")
						if err == nil || err.Error() != "WSL_1_REQUIRES_WSL_2" {
							t.Fatal("WSL 1 delegated", err)
						}
						p.noEffects()
					}
					for _, g := range p.guests {
						if scenario == "stopped" && (g.running || g.reads != 0) {
							t.Fatal("preview inspected or opened stopped guest")
						}
						if scenario == "wsl1" && host == "windows" && g.reads != 0 {
							t.Fatal("WSL 1 inspected")
						}
					}
				})
			}
		})
	}
}

func TestE2EDesktopConsentAndHandoff(t *testing.T) {
	for _, host := range []string{"windows", "darwin"} {
		t.Run(host, func(t *testing.T) {
			for _, running := range []bool{true, false} {
				p := e2eDesktopFixture(t, host)
				p.guests[0].running = running
				target := p.provider() + ":" + p.guests[0].name
				_, err := e2eDesktopRun(t, p, "--apply", "--target", target)
				if err == nil || !strings.Contains(err.Error(), "CONSENT") {
					t.Fatal("opening lacked consent", err)
				}
				p.noEffects()
				if p.guests[0].running != running {
					t.Fatal("nonconsented start")
				}
				p.ledger = nil
				readsBefore := p.guests[0].reads
				_, err = e2eDesktopRun(t, p, "--apply", "--target", target,
					"--consent-open-target")
				if err != nil {
					t.Fatal(err)
				}
				expectedReads := 2
				if running {
					expectedReads = 4
				}
				if len(p.entered) == 0 || p.guests[0].reads-readsBefore != expectedReads {
					t.Fatal("handoff missing independent repeated observation", p.ledger)
				}
				starts := 0
				for _, entry := range p.ledger {
					if strings.HasPrefix(entry, "start:") {
						starts++
					}
				}
				expected := 0
				if !running {
					expected = 1
				}
				if starts != expected {
					t.Fatal("guest start count", starts, expected)
				}
			}
		})
	}
}

func TestE2EDesktopDrift(t *testing.T) {
	for _, host := range []string{"windows", "darwin"} {
		for _, drift := range []string{"identity", "architecture", "isolation"} {
			t.Run(host+"/"+drift, func(t *testing.T) {
				p := e2eDesktopFixture(t, host)
				p.guests[0].drift = drift
				_, err := e2eDesktopRun(t, p, "--apply", "--consent-open-target")
				if err == nil {
					t.Fatal("changed guest delegated", drift)
				}
				p.noEffects()
				if p.guests[0].reads < 2 {
					t.Fatal("drift not observed")
				}
			})
		}
	}
}

func TestE2EDesktopEnvironment(t *testing.T) {
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN", "WSLENV", "CODEX_HOME",
		"GH_CONFIG_DIR", "HOME", "USERPROFILE"} {
		t.Setenv(key, "synthetic-desktop-secret")
	}
	for _, entry := range desktopEnvironment() {
		if strings.Contains(entry, "synthetic-desktop-secret") {
			t.Fatal("desktop credential or home forwarded")
		}
	}
}
