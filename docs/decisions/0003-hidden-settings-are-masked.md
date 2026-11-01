# 0003: Settings a language lacks are hidden, kept, and masked to a neutral value

Status: proposed (multi-language design, Phase 1)

## Context

The owner: "not all settings will work in all languages. we have kanji
specific settings." A hidden setting must keep its stored value and must not
change behaviour. Those values are read in dozens of places: the renderer,
the themes, Anki, keybinds, the Design preview.

## Decision

`OPTION_REQUIREMENTS` maps each option that needs a capability to the
capability and a neutral value. Settings hides the control; the projection
(`HDProfiles.projectOptions`) replaces the value by its neutral value for a
profile without the capability; storage keeps the user's value.

## Options rejected

- **Disable instead of hide.** The owner asked for hidden, and a disabled
  pitch-accent panel in an English profile is noise.
- **Check the capability at every use site.** Every renderer, theme and Anki
  marker would need the same `if`, and a missed one would let a hidden value
  change behaviour.
- **Reset the value when the language lacks it.** Loses the user's choice when
  the same setting comes back in another profile or after a pack gains the
  capability.

## Consequences

- Consumers need no capability code to stay correct.
- A pack that gains a capability later shows the user's old value again.
