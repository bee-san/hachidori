#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ELEVENLABS_OUTBOUND_CALL_URL = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";

const ELEVENLABS_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SECRET = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const E164_PHONE = /^\+[1-9]\d{7,14}$/u;
const CALLER_ORGANIZATION = /^[\p{L}\p{N}][\p{L}\p{N} .,'’&()+/-]{0,99}$/u;

export const USAGE = `Usage: node scripts/elevenlabs-doctor-email-call.mjs --confirm-authorized-to <E.164 number>

Required environment variables:
  ELEVENLABS_API_KEY          ElevenLabs API key
  ELEVENLABS_AGENT_ID         ElevenLabs agent ID
  ELEVENLABS_PHONE_NUMBER_ID  Imported Twilio phone-number ID
  DOCTOR_OFFICE_PHONE         Destination in E.164 form, for example +441632960000
  CALLER_ORGANIZATION         Non-patient organization the agent identifies
  CALLBACK_PHONE              Non-patient callback number in E.164 form

--confirm-authorized-to must exactly match DOCTOR_OFFICE_PHONE and confirms that
this recipient authorized the automated AI call and applicable law permits it.`;

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Set ${name} before starting a call.`);
  }
  return value;
}

function validated(value, pattern, name, description) {
  if (!pattern.test(value)) throw new Error(`${name} must be ${description}.`);
  return value;
}

export function readDoctorEmailCallConfig(environment = process.env) {
  return {
    apiKey: validated(required(environment, "ELEVENLABS_API_KEY"), SECRET,
      "ELEVENLABS_API_KEY", "a non-empty credential without whitespace or control characters"),
    agentId: validated(required(environment, "ELEVENLABS_AGENT_ID"), ELEVENLABS_ID,
      "ELEVENLABS_AGENT_ID", "1-128 letters, numbers, underscores, or hyphens"),
    agentPhoneNumberId: validated(required(environment, "ELEVENLABS_PHONE_NUMBER_ID"), ELEVENLABS_ID,
      "ELEVENLABS_PHONE_NUMBER_ID", "1-128 letters, numbers, underscores, or hyphens"),
    toNumber: validated(required(environment, "DOCTOR_OFFICE_PHONE"), E164_PHONE,
      "DOCTOR_OFFICE_PHONE", "an E.164 phone number beginning with +"),
    callerOrganization: validated(required(environment, "CALLER_ORGANIZATION"), CALLER_ORGANIZATION,
      "CALLER_ORGANIZATION", "1-100 plain organization-name characters"),
    callbackNumber: validated(required(environment, "CALLBACK_PHONE"), E164_PHONE,
      "CALLBACK_PHONE", "an E.164 phone number beginning with +"),
  };
}

export function doctorEmailCallPrompt({ callerOrganization, callbackNumber }) {
  return `You are an AI assistant placing one non-marketing administrative call on behalf of ${callerOrganization}.

Your only goal is to ask for the doctor's office's general-purpose email address. The first message contains a mandatory disclosure that you are an AI assistant, that the call may be recorded and shared with ElevenLabs and its service providers, and that ${callbackNumber} is the callback number. Never skip, shorten, or contradict that disclosure, and never claim to be human. Wait for an explicit agreement to continue before asking for the email address.

If the recipient clearly agrees to continue, request only a general or public office email address. Repeat the address back once, slowly, and ask whether it is correct. Do not ask for, provide, confirm, infer, or discuss any patient identity, symptoms, diagnosis, treatment, prescription, appointment, insurance, billing, or other medical information. If anyone begins sharing such information, politely stop them and explain that you can only request the office's general email address.

If the recipient declines, does not clearly agree, objects to automation or recording, asks not to be called, or does not want to provide an address, apologize and end the call immediately. If voicemail or another automated system answers, do not leave a message or enter information; end the call. After obtaining the address or learning that it is unavailable, thank the recipient and end the call.`;
}

export function doctorEmailFirstMessage({ callerOrganization, callbackNumber }) {
  return `Hello, I'm an AI assistant calling on behalf of ${callerOrganization}. This call may be recorded and shared with ElevenLabs and its service providers to provide this service. The callback number is ${callbackNumber}. If you do not agree to continue, please say so and I will end the call. May I continue?`;
}

export function buildDoctorEmailCallRequest(config) {
  const validatedConfig = readDoctorEmailCallConfig({
    ELEVENLABS_API_KEY: config.apiKey,
    ELEVENLABS_AGENT_ID: config.agentId,
    ELEVENLABS_PHONE_NUMBER_ID: config.agentPhoneNumberId,
    DOCTOR_OFFICE_PHONE: config.toNumber,
    CALLER_ORGANIZATION: config.callerOrganization,
    CALLBACK_PHONE: config.callbackNumber,
  });
  return {
    agent_id: validatedConfig.agentId,
    agent_phone_number_id: validatedConfig.agentPhoneNumberId,
    to_number: validatedConfig.toNumber,
    conversation_initiation_client_data: {
      conversation_config_override: {
        agent: {
          prompt: { prompt: doctorEmailCallPrompt(validatedConfig) },
          first_message: doctorEmailFirstMessage(validatedConfig),
        },
      },
    },
    call_recording_enabled: false,
  };
}

function responseIdentifier(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ELEVENLABS_ID.test(value)) {
    throw new Error("ElevenLabs accepted the request but returned an invalid call identifier. Check the dashboard; do not retry.");
  }
  return value;
}

export async function startDoctorEmailCall(config, { authorizedTo = null, fetchImpl = globalThis.fetch } = {}) {
  if (authorizedTo !== config.toNumber) {
    throw new Error("Refusing to call without authorization for the exact destination.");
  }
  const body = buildDoctorEmailCallRequest(config);
  let response;
  try {
    response = await fetchImpl(ELEVENLABS_OUTBOUND_CALL_URL, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": config.apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error("The ElevenLabs call request outcome is unknown. Check the dashboard before retrying.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 422) {
      throw new Error("ElevenLabs rejected the call request with HTTP 422.");
    }
    throw new Error(`ElevenLabs returned HTTP ${response.status}; the call outcome is unknown. Check the dashboard before retrying.`);
  }
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error("ElevenLabs returned an unreadable success response. Check the dashboard before retrying.", { cause: error });
  }
  if (result?.success === false) {
    throw new Error("ElevenLabs did not accept the call request.");
  }
  if (result?.success !== true) {
    throw new Error("ElevenLabs returned an ambiguous success response. Check the dashboard before retrying.");
  }
  return {
    conversationId: responseIdentifier(result.conversation_id),
    callSid: responseIdentifier(result.callSid),
  };
}

export function parseDoctorEmailCallArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--help") return { help: true, authorizedTo: null };
  if (arguments_.length === 2 && arguments_[0] === "--confirm-authorized-to") {
    return {
      help: false,
      authorizedTo: validated(arguments_[1], E164_PHONE,
        "--confirm-authorized-to", "an E.164 phone number beginning with +"),
    };
  }
  throw new Error(USAGE);
}

export async function runDoctorEmailCallCli({
  arguments_: argumentsInput = process.argv.slice(2),
  environment = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const arguments_ = parseDoctorEmailCallArguments(argumentsInput);
  if (arguments_.help) {
    log(USAGE);
    return null;
  }
  const config = readDoctorEmailCallConfig(environment);
  const result = await startDoctorEmailCall(config, {
    authorizedTo: arguments_.authorizedTo,
    fetchImpl,
  });
  log("ElevenLabs accepted the outbound call request.");
  if (result.conversationId) log(`Conversation ID: ${result.conversationId}`);
  if (result.callSid) log(`Provider call ID: ${result.callSid}`);
  if (!result.conversationId && !result.callSid) {
    log("No tracking identifier was returned; check the dashboard before retrying.");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDoctorEmailCallCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
