# Windows stack launcher (RETIRED)

**This temporary stopgap has been retired.**

Cross-platform service management is now natively provided by the `sigil service` command suite and `.sigil/service.json` configuration, tracked and delivered in [#132](https://github.com/sorensencc-dotcom/sigil/issues/132).

For setup, service configuration, and Task Scheduler commands, refer to:
- [`docs/service-config.md`](../../docs/service-config.md)

### Migration commands

- **Install services**: `sigil service install`
- **Check health / status**: `sigil service status`
- **Start services**: `sigil service start`
- **Stop services**: `sigil service stop`
- **Uninstall services**: `sigil service uninstall`

The legacy scripts in this folder (`start-sigil-stack.ps1` and `register-sigil-task.ps1`) are preserved as thin deprecation wrappers delegating directly to `sigil service`.
