//go:build linux

package restore

import (
	"errors"
	"os"
	"syscall"
)

func lchown(path string, uid, gid int) error {
	err := syscall.Lchown(path, uid, gid)
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.EPERM) {
		return nil
	}
	return err
}
