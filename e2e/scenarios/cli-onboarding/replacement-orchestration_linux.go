//go:build linux

package cli

import "errors"

// Fixture component orchestration; production host locking is not exercised.
func (a App) e2eApplyRebuild(repo Repository, user User, provider string, token []byte,
	encoder installResultEncoder, ops rebuildOperations) error {
	intent, unmet, err := previewRebuild(repo, user, provider, ops)
	if err != nil {
		return err
	}
	if len(unmet) != 0 {
		return errors.New("REBUILD_PREREQUISITES_UNMET")
	}
	path, err := sharedMutationPath()
	if err != nil {
		return err
	}
	// Prepare and serialize only fixture-private storage, never the host lock.
	unlock, err := installIntentLock(path)
	if err != nil {
		return err
	}
	defer unlock()
	save := func() error { return saveRebuildIntent(path, intent) }
	if err := save(); err != nil {
		return err
	}
	if err := a.resumeRebuild(&intent, token, ops, save, encoder); err != nil {
		_ = encoder.Encode(map[string]any{"status": "pending",
			"code":         "REBUILD_INCOMPLETE_RESUME_SAME_COMMAND",
			"retirementId": intent.RetirementID, "activation": "unverified"})
		return &CommandError{Code: err.Error(), Exit: 2}
	}
	// Intent is retained through successful activation and output. Removing it
	// restores ordinary init only after that exact fixed operation has succeeded.
	return removePrivateRebuildIntent(path)
}
