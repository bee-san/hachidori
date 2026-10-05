<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Call a doctor's office for its email address

`scripts/elevenlabs-doctor-email-call.mjs` is a standalone developer example. It starts one outbound call through an existing [ElevenLabs Agent and imported Twilio number](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration). It is not loaded by or shipped in the Hachidori extension.

The agent identifies itself as AI, explains that the call may be recorded and shared with ElevenLabs and its service providers, asks permission to continue, and requests only the office's general email address. It is instructed to stop if someone objects and to avoid all patient and medical information.

## Before calling

You need Node 22, an ElevenLabs API key, an ElevenLabs Agent, and a Twilio number imported into ElevenLabs. In the agent's **Security** settings, enable the **System prompt** and **First message** overrides; ElevenLabs disables them by default. Give the agent its **End call** system tool so it can finish after the request.

To have the flow produce a structured answer, add this string item under **Analysis → Data collection** before calling:

- Identifier: `office_email`
- Description: `Extract only the doctor's office's general email address in standard user@domain form. Return null when no address was clearly confirmed.`

The extracted value appears in the conversation history and in an authenticated [post-call transcription webhook](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks). Verify webhook HMAC signatures before accepting results. The local command deliberately stops after call initiation instead of polling for or storing contact data; use the dashboard or webhook to read `office_email`.

## Configure

Inject the API key from a password or secrets manager; do not put it in this repository, a `.env` file, a shell script, or a command-line argument. Export these values in the process that will make the call:

```sh
export ELEVENLABS_API_KEY='<from your secrets manager>'
export ELEVENLABS_AGENT_ID='agent_...'
export ELEVENLABS_PHONE_NUMBER_ID='phnum_...'
export DOCTOR_OFFICE_PHONE='+441632960000'
export CALLER_ORGANIZATION='Example Organization'
export CALLBACK_PHONE='+441632960001'
```

The `+44 1632 960xxx` values above are Ofcom-reserved drama numbers and will not reach a real office; replace both before an authorized call. Both phone numbers must use [E.164](https://www.twilio.com/docs/glossary/what-e164) notation. `CALLER_ORGANIZATION` is spoken to the recipient and must not identify a patient. `CALLBACK_PHONE` must likewise be a non-patient business contact. The script sends these values to ElevenLabs but never prints them. Rotate the API key regularly and immediately replace it if it is exposed.

## Place one call

Only run the command after confirming that the recipient authorized an automated AI call and that the call is permitted at that time and location:

```sh
node scripts/elevenlabs-doctor-email-call.mjs \
  --confirm-authorized-to "$DOCTOR_OFFICE_PHONE"
```

The acknowledgement must exactly match `DOCTOR_OFFICE_PHONE`, which prevents a stale destination from being called under a generic confirmation. The command makes one `POST` request to ElevenLabs' fixed `/v1/convai/twilio/outbound-call` endpoint. It does not retry or batch calls. On success, it prints the ElevenLabs conversation ID and Twilio call ID, which are safe to use to locate the conversation in the ElevenLabs dashboard. If transport fails, ElevenLabs returns an unexpected HTTP status, or a successful response is malformed, the command treats the call outcome as unknown: check the dashboard before deciding whether to retry.

`call_recording_enabled` is set to `false`, which disables Twilio's separate call recording. ElevenLabs still processes the conversation and may retain a transcript or audio according to the workspace configuration, so the opening disclosure remains required. Review ElevenLabs' [retention controls](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention) before use.

## Consent and healthcare boundary

Automated outbound calling, AI-generated voices, call recording, and contact-data retention are regulated differently by country and state. ElevenLabs' [TCPA guidance](https://elevenlabs.io/docs/eleven-agents/legal/tcpa) says US outbound AI calls require the applicable form of prior express consent, including non-marketing calls. The `--confirm-authorized-to` value is an acknowledgement bound to one destination, not a consent-management system or legal determination. Maintain any records and opt-out handling required for your use case.

This example is deliberately limited to a public or general office email address. Do not use it to send or request a patient's identity, symptoms, diagnosis, treatment, prescription, appointment, insurance, billing, or other protected health information. ElevenLabs states that PHI must not be submitted unless an eligible Enterprise customer has an executed BAA and uses Zero Retention Mode as permitted by that agreement; see its [HIPAA guidance](https://elevenlabs.io/docs/eleven-agents/legal/hipaa).

## Test without calling

The focused test replaces `fetch` with a local stub and never contacts ElevenLabs or Twilio:

```sh
node --test test/elevenlabs-doctor-email-call.test.mjs
```
