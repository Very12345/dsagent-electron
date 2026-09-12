# WebAgent DSH integration

This package has a host capability layer and one small DSH settings card. It
does not manipulate the DOM, replace Think rendering, add sidebar controls, or
patch bundled DSH WebUI assets. Its client module only contributes the native
web-search provider selector through DSH's public settings slot.

WebAgent runs the official `@deepseek-ai/dsh` package and writes only its own
provider entry to the isolated Web profile. A clean GitHub checkout is kept as
an upstream comparison baseline; WebAgent never builds patched frontend assets
from that checkout.

The host plugin registers `webagent-web-search` as a DSH web-search router. The
settings card selects the signed-in DeepSeek or Qwen webpage account. It never
uses the metered DeepSeek API search endpoint. Each search uses an ephemeral
webpage conversation that Runtime deletes after completion. The ordinary
public-HTTP `web_fetch` provider remains unchanged.

The unified `deepseek.web` model declares native image input. User attachments
and workspace images read through DSH's official `read_image` tool therefore
stay in the current Session and travel through the ordinary multimodal request
path. This integration intentionally adds no parallel DeepSeek vision tool.
The host integration contributes a DSH-owned complete prompt tailored to the webpage
transport. Runtime encodes that compact prompt, the authoritative context
snapshot, exact tool schemas, tool results and image attachments into a
versioned bridge envelope. It never copies the much larger stock Harness prompt
verbatim, and it never invents prompt policy outside the DSH plugin.

The same package registers four explicit `chat.qwen.ai` capabilities:
`qianwen_text`, `qianwen_search`, `qianwen_image`, and `qianwen_voice`. Text
keeps Qwen-native tools off, search uses the native `search` chat type for only
that request, image generation uses the native `t2i` payload with an explicit
Qwen-Image model and size, and voice input transcribes a workspace audio file.
These tools are denied only in DSH's minimal preset so its upstream one-shell
contract remains unchanged.

Standard mode also exposes `Qwen3.8-Max - Web` and `Qwen3.7-Plus - Web` as
separate selectable agent models. Both keep the upstream SSE transport active
when DSH tools are advertised and forward reasoning deltas as
`reasoning_content`; the legacy `qwen.text.web` id remains a hidden compatibility
alias for existing sessions. Search and image capability endpoint ids are
internal and are not advertised as selectable LLM models. Lark/Feishu bridging
is provided by the separate `dsh-lark-link` plugin, never by this package.

`DeepSeekHarnessService` installs the package into its isolated Web profile and
loads it through a separate `--patch` layer.
