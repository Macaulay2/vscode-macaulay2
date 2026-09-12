# Changelog

## 1.0.0

This release moves to the `Macaulay2` publisher with extension ID `Macaulay2.macaulay2`. Future updates will be published under this ID. Users of `coreysharris.macaulay2` should follow the [migration instructions](README.md#moving-to-the-macaulay2-publisher) to install the new extension, remove the old one, and update explicit extension ID references. Existing `macaulay2.*` settings and command keybindings continue to apply.

- Add optional language-server integration with automatic discovery, lazy startup, and a restart command.
- Generate syntax grammars and built-in symbol completions from Macaulay2, including improved operator, numeric, raw-string, and SimpleDoc highlighting.
- Improve rich-output layout and preserve protocol line breaks in the REPL.
