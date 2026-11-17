//go:build linux

package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

type e2eReplacementEffect struct {
	Kind string
	ID   int64
}

type e2eReplacementAdoption struct {
	IDs   []int64
	Agent agentBinding
}

// Fixture records are independent of CLI receipts and survive invocation loss.
// These wrappers observe controlled effects; they make no retirement decisions.
type e2eReplacementObserver struct {
	Effects   []e2eReplacementEffect
	HostState string
	Fault     string
}

func newE2EReplacementObserver(t *testing.T) *e2eReplacementObserver {
	t.Helper()
	o := &e2eReplacementObserver{
		HostState: filepath.Join(t.TempDir(), "controlled-host.json"),
	}
	o.writeHost(t, e2eReplacementHostState{
		Services:  map[int64]bool{25: true, 26: true, 99: true},
		Adoptions: map[int64]e2eReplacementAdoption{}, Wakes: map[int64]int{},
	})
	return o
}

func e2eReplacementIDs(d *rebuildDriver) []int64 {
	ids := []int64{}
	for _, runner := range d.runners {
		ids = append(ids, runner.ID)
	}
	return ids
}

type e2eObservedReplacementAPI struct {
	driver   *rebuildDriver
	observer *e2eReplacementObserver
}

func (a e2eObservedReplacementAPI) Call(method, path string, in, out any) error {
	before := e2eReplacementIDs(a.driver)
	err := a.driver.Call(method, path, in, out)
	after := e2eReplacementIDs(a.driver)
	for _, id := range before {
		if !slices.Contains(after, id) {
			a.observer.Effects = append(a.observer.Effects,
				e2eReplacementEffect{"remove", id})
		}
	}
	return err
}

func (o *e2eReplacementObserver) operations(t *testing.T, d *rebuildDriver,
	ops rebuildOperations) rebuildOperations {
	t.Helper()
	record := func(kind string) {
		o.Effects = append(o.Effects, e2eReplacementEffect{Kind: kind})
	}
	ops = o.hostOperations(t, d, ops)
	prepare := ops.prepare
	ops.prepare = func(p InitPlan) error { record("prepare"); return prepare(p) }
	setup := ops.host.setupAgent
	ops.host.setupAgent = func(p InitPlan, token []byte) error {
		record("provider")
		return setup(p, token)
	}
	credentials := ops.host.credentials
	ops.host.credentials = func(id int64, token []byte) error {
		record("credentials")
		return credentials(id, token)
	}
	stage := ops.stage
	ops.stage = func(p InitPlan, i rebuildIntent) ([]string, error) {
		record("stage")
		return stage(p, i)
	}
	packages := ops.packages
	ops.packages = func(p InitPlan, i rebuildIntent) error {
		record("packages")
		return packages(p, i)
	}
	register := ops.register
	ops.register = func(p InitPlan, i rebuildIntent,
		save func([]sharedRegistration) error) error {
		before := e2eReplacementIDs(d)
		if slices.Contains(before, int64(25)) || slices.Contains(before, int64(26)) ||
			d.retirement == nil || d.retirement.Phase != "retired" {
			t.Fatal("registration before independent old absence and Core retirement")
		}
		err := register(p, i, save)
		for _, id := range e2eReplacementIDs(d) {
			if !slices.Contains(before, id) {
				o.Effects = append(o.Effects, e2eReplacementEffect{"register", id})
			}
		}
		return err
	}

	return ops
}

func (o *e2eReplacementObserver) verify(t *testing.T, d *rebuildDriver) {
	t.Helper()
	registrations := []e2eReplacementEffect{}
	for _, effect := range o.Effects {
		if effect.Kind == "remove" || effect.Kind == "register" {
			registrations = append(registrations, effect)
		}
	}
	e2eEqual(t, registrations, []e2eReplacementEffect{
		{"remove", 25}, {"remove", 26}, {"register", 31}, {"register", 32},
	})
	if err := o.completion(d); err != nil {
		t.Fatal(err)
	}
	e2eEqual(t, d.retirement.Release, "released")
}

// Completion uses host readback, never a successful operation reply.
func (o *e2eReplacementObserver) completion(d *rebuildDriver) error {
	state, err := o.readHost()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(state.Services, map[int64]bool{
		25: false, 26: false, 31: true, 32: true, 99: true,
	}) {
		return fmt.Errorf("incomplete or contradictory services: %v", state.Services)
	}
	if len(state.Adoptions) != 2 {
		return fmt.Errorf("incomplete or contradictory adoption inventory")
	}
	for _, id := range []int64{10, 11} {
		want := e2eReplacementAdoption{[]int64{31, 32}, d.binding}
		if !reflect.DeepEqual(state.Adoptions[id], want) {
			return fmt.Errorf("incomplete or contradictory adoption: %d", id)
		}
	}
	if !reflect.DeepEqual(state.Wakes, map[int64]int{10: 1, 11: 1}) {
		return fmt.Errorf("incomplete or contradictory wakes: %v", state.Wakes)
	}
	return nil
}

func e2eReplacementSecrets(t *testing.T, d *rebuildDriver) map[string]string {
	t.Helper()
	result := map[string]string{}
	for _, path := range d.paths {
		for _, name := range stagedSecrets {
			file := filepath.Join(path, name)
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			result[file] = string(data)
		}
	}
	return result
}
