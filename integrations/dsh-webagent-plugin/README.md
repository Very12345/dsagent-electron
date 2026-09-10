# WebAgent DSH integration

This package is host-only. It does not inject a DSH client module, manipulate
the DOM, replace Think rendering, add sidebar controls, or alter the bundled
DSH WebUI. The WebAgent process treats the official DSH installation as an
unchanged upstream application.

WebAgent runs the official `@deepseek-ai/dsh` package and writes only its own
provider entry to the isolated Web profile. A clean GitHub checkout is kept as
an upstream comparison baseline; WebAgent never builds patched frontend assets
from that checkout.

The host plugin contributes a `deepseek_vision` tool for local PNG, JPEG, GIF,
BMP and WebP files. Image input is routed through the selectable unified
`deepseek.web` model; there is no separate Vision model.
The tool remains useful when an agent wants to inspect a workspace image without
changing the session's capability switches.
The host integration contributes a DSH-owned complete prompt tailored to the webpage
transport. Runtime encodes that compact prompt, the authoritative context
snapshot, exact tool schemas, tool results and image attachments into a
versioned bridge envelope. It never copies the much larger stock Harness prompt
verbatim, and it never invents prompt policy outside the DSH plugin.

`DeepSeekHarnessService` installs the package into its isolated Web profile and
loads it through a separate `--patch` layer.
