//go:build !linux

package restore

// lchown is a no-op on non-Linux platforms. Persistd runs in a Linux
// container in production; non-Linux builds exist only for local
// development and unit-test runs that don't exercise ownership.
func lchown(string, int, int) error { return nil }
