//go:build linux

package cli

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
)

// This inventory is independent of CLI output. No callback executes a process.
type e2eGuest struct {
	name, identity, arch string
	running, adopted     bool
	version              int
	reads                int
	drift                string
}

type e2eDesktop struct {
	t       *testing.T
	host    string
	guests  []*e2eGuest
	ledger  []string
	entered []string
}

func e2eDesktopFixture(t *testing.T, host string) *e2eDesktop {
	arch := "amd64"
	if host == "darwin" {
		arch = "arm64"
	}
	return &e2eDesktop{t: t, host: host, guests: []*e2eGuest{{
		name: "Ubuntu Dev", identity: strings.Repeat("1", 32), arch: arch,
		running: true, version: 2,
	}}}
}

func e2eUTF16(text string) []byte {
	units := utf16.Encode([]rune(text))
	data := make([]byte, 2+len(units)*2)
	copy(data, "\xff\xfe")
	for i, unit := range units {
		binary.LittleEndian.PutUint16(data[2+i*2:], unit)
	}
	return data
}

func (p *e2eDesktop) provider() string {
	if p.host == "windows" {
		return "wsl"
	}
	return "multipass"
}

func (p *e2eDesktop) inventory(args []string) ([]byte, bool) {
	if p.host == "darwin" {
		if !slices.Equal(args, []string{"list", "--format", "json"}) {
			return nil, false
		}
		items := []map[string]string{}
		for _, g := range p.guests {
			state := "Stopped"
			if g.running {
				state = "Running"
			}
			items = append(items, map[string]string{"name": g.name, "state": state,
				"release": "Ubuntu 24.04 LTS"})
		}
		data, err := json.Marshal(map[string]any{"list": items})
		if err != nil {
			p.t.Fatal(err)
		}
		return data, true
	}
	var text strings.Builder
	switch {
	case slices.Equal(args, []string{"--list", "--quiet"}):
		for _, g := range p.guests {
			fmt.Fprintln(&text, g.name)
		}
	case slices.Equal(args, []string{"--list", "--verbose"}):
		text.WriteString("NAME STATE VERSION\r\n")
		for _, g := range p.guests {
			fmt.Fprintf(&text, "  %s  Running  %d\r\n", g.name, g.version)
		}
	case slices.Equal(args, []string{"--list", "--running", "--quiet"}):
		for _, g := range p.guests {
			if g.running {
				fmt.Fprintln(&text, g.name)
			}
		}
	default:
		return nil, false
	}
	return e2eUTF16(text.String()), true
}

func (p *e2eDesktop) command(tool string, args []string) (*e2eGuest, []string) {
	for _, g := range p.guests {
		prefix := []string{"exec", g.name, "--"}
		expected := "multipass"
		if p.host == "windows" {
			expected = "wsl.exe"
			prefix = []string{"--distribution", g.name, "--cd", "~", "--exec"}
		}
		if tool == expected && len(args) >= len(prefix) &&
			slices.Equal(args[:len(prefix)], prefix) {
			return g, args[len(prefix):]
		}
	}
	p.t.Fatalf("unexpected guest argv: %s %q", tool, args)
	return nil, nil
}

func (p *e2eDesktop) Run(tool string, args []string, input []byte) ([]byte, error) {
	p.t.Helper()
	p.ledger = append(p.ledger, "query:"+tool+" "+strings.Join(args, " "))
	if len(p.ledger) > 160 || input != nil {
		p.t.Fatal("unbounded/unsafe query")
	}
	expected := "multipass"
	if p.host == "windows" {
		expected = "wsl.exe"
	}
	if tool != expected {
		p.t.Fatal("unexpected provider", tool)
	}
	if data, ok := p.inventory(args); ok {
		return data, nil
	}
	if tool == "multipass" && len(args) == 2 && args[0] == "start" {
		for _, g := range p.guests {
			if g.name == args[1] {
				p.ledger = append(p.ledger, "start:"+g.name)
				g.running = true
				return nil, nil
			}
		}
	}
	g, command := p.command(tool, args)
	if slices.Equal(command, []string{"true"}) && !g.running {
		p.ledger = append(p.ledger, "start:"+g.name)
		g.running = true
		return nil, nil
	}
	if !g.running {
		p.t.Fatal("stopped guest inspected")
	}
	switch strings.Join(command, " ") {
	case "cat /etc/machine-id":
		g.reads++
		if g.drift == "identity" && g.reads > 1 {
			return []byte(strings.Repeat("f", 32)), nil
		}
		return []byte(g.identity), nil
	case "gh extension list":
		return []byte("gh nibfin"), nil
	case "gh nibfin preflight --repo example/project":
		arch := g.arch
		if g.drift == "architecture" && g.reads > 1 {
			if arch == "amd64" {
				arch = "arm64"
			} else {
				arch = "amd64"
			}
		}
		o := e2eGuestObservation(arch, "")
		if g.drift == "isolation" && g.reads > 1 {
			o = e2eGuestObservation(arch, "/sys/module/apparmor/parameters/enabled")
		}
		data, err := json.Marshal(map[string]any{"host_os": "linux",
			"linux_identity": g.identity, "linux_target": o,
			"protected_execution": "unverified", "shared_host_adopted": g.adopted})
		if err != nil {
			p.t.Fatal(err)
		}
		return data, &CommandError{Code: "GUEST_EXIT_2", Exit: 2}
	}
	p.t.Fatalf("unexpected command: %q", command)
	return nil, nil
}

func e2eGuestObservation(arch, missing string) linuxTargetObservation {
	files := eligibleLinuxFiles()
	delete(files, missing)
	read := func(path string) ([]byte, error) {
		value, ok := files[path]
		if !ok {
			return nil, fmt.Errorf("fixture file unavailable: %s", path)
		}
		return []byte(value), nil
	}
	kernel, machine := "x86_64", uint16(62)
	if arch == "arm64" {
		kernel, machine = "aarch64", 183
	}
	o := observeLinuxTarget(platformFixture(), read, kernel, arch, machine)
	// A fresh dedicated engine is intentionally unprepared, not unsupported.
	o.Checks = append(o.Checks,
		capability{"dedicated_engine", "unverified", "CORE_PREPARATION_REQUIRED"})
	return o
}

func (p *e2eDesktop) EnterGuest(_ context.Context, tool string,
	args []string, _ io.Writer) error {
	p.ledger = append(p.ledger, "terminal:"+tool+" "+strings.Join(args, " "))
	p.entered = append([]string{tool}, args...)
	g, command := p.command(tool, args)
	expected := []string{"gh", "nibfin", "init", "--repo", "example/project",
		"--apply", "--linux-target-identity", g.identity, "--linux-target-arch", g.arch}
	if !slices.Equal(command, expected) {
		p.t.Fatal("unbound handoff", command)
	}
	// Bind controlled asset selection to this independently observed guest, not
	// to a target reconstructed from CLI output. No installer or Core runs.
	c, assets := e2ePlatformBytes(p.t)
	api := initFixture()
	installSharedProducerFixture(p.t, api, c)
	e2eSelectDesktopAssets(p.t, g.arch, api, assets)
	p.ledger = append(p.ledger, "asset-selection:"+p.provider()+":"+g.name+":"+g.arch)
	return nil
}

func (p *e2eDesktop) noEffects() {
	p.t.Helper()
	for _, entry := range p.ledger {
		if !strings.HasPrefix(entry, "query:") {
			p.t.Fatal("unexpected effect", entry)
		}
	}
	if len(p.entered) != 0 {
		p.t.Fatal("unexpected terminal entry")
	}
}
