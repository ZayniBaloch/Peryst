# ScopeKeep for VS Code

Review project-scoped AI memories without leaving the editor.

## Capabilities

- Browse recent memories for the active workspace.
- Search local memories by meaning and keyword.
- Edit a memory through ScopeKeep's versioned update path.
- Permanently delete a memory after explicit confirmation.
- See namespace, importance, creation time, and archived state.
- Start and stop an authenticated loopback-only review service.

The extension starts ScopeKeep locally with the active workspace root. It does not create a cloud account or sync memory to ScopeKeep servers. Your configured AI client may separately transmit retrieved context to its model provider.

## Development

Run `npm run check`, then press F5 from this folder using VS Code's Extension Development Host.
