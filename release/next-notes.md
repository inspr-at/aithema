# Next release — unreleased

## Grok Voice (xAI), AIT-317 / AIT-351

**not yet qualified in live use** — retain this exact label until Markus has used
it. Offline fixture qualification does not change the label.

The optional `@inspr/aithema-plugin-grok-voice` module joins the release closure,
with exact core/server dependencies, coordinator/helper exports and browser audio
assets. Installed imports, private binding setup, consent/account evidence,
charging and recovery are in the [embedding guide](../docs/embedding.md#grok-voice-host-setup-and-release-imports-ait-351)
and [plugin README](../plugins/grok-voice/README.md). The installed-artifact gate
imports shipped bytes offline and runs a joined synthetic call.

Architecture (b): **xAI STT → Aithema's admitted reasoning → xAI TTS**. xAI never
writes answers. Markus approved xAI as a direct recipient (Desk dc3ec428), using
**`voice-xai` v1** and the exact DE/EN text in the manifest. Recipient: **SpaceXAI
LLC (“SpaceXSI”)**, US seat; international processing, **no guaranteed region**.
Settings shows the recipient seat separately from processing geography. Switching
providers can end the active call and never starts a new paid call automatically.

Visitor active duration is server-side **measured by Aithema**, with acknowledged
pauses excluded and confirmation at close. Upstream STT/TTS are fresh child claims
and remain **estimated** until a billed-cost receipt. TTS counts the Unicode code
points sent. Cancel and timeout keep consumed reservations; parent close does not
release unresolved children. Recovery requires fresh authorization/epochs/claims
and never replays old synthesis.

Interruption retains the complete generated reply and shows **Unterbrochen** /
**Interrupted**. The model is told the heard length is unknown because xAI reports
no heard position. This approved difference leaves ElevenLabs's existing
heard-prefix correction unchanged.

Owner-use setup requires an xAI account with voice access and **Zero Data
Retention switched on**, plus a server-side secret reference in the private
binding and current account evidence. **Never ask for a key.** Public docs read
**2026-10-18** supplied dated prices: REST STT **$0.10/hour**, streaming STT
**$0.20/hour**, TTS **$15/1M characters**. No billed-cost receipt, live acoustic
quality, German speech qualification or real account qualification is claimed.
The plugin README links the dated public sources; fixtures are synthetic.

This is release inclusion only: **no tag, release or publication**. Merge waits
for Tick's morning QA of packages 5–7 and LEAD's decision on which RC carries
Grok. The next RC builder converts these notes; publication needs a later RC
with Markus's Desk go. Existing version files and `release/notes.md` are unchanged.
