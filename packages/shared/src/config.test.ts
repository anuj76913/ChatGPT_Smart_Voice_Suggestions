import { describe, expect, it } from 'vitest';
import { DEFAULT_SVS_CONFIG, configuredGroqModels } from './config';
import { PRESET_BY_INTENT, VOICE_INTENTS } from './intents';

describe('DEFAULT_SVS_CONFIG matches PRD requirements', () => {
  it('FR-5 frequency caps and pause', () => {
    expect(DEFAULT_SVS_CONFIG.cap.perConversation).toBe(1);
    expect(DEFAULT_SVS_CONFIG.cap.perRollingWeek).toBe(3);
    expect(DEFAULT_SVS_CONFIG.cap.rollingWindowHours).toBe(7 * 24);
    expect(DEFAULT_SVS_CONFIG.pause.consecutiveDismissals).toBe(3);
    expect(DEFAULT_SVS_CONFIG.pause.days).toBe(14);
  });

  it('FR-1 precision target, NFR voice start budget and WAVL definition', () => {
    expect(DEFAULT_SVS_CONFIG.classifier.precisionTarget).toBe(0.85);
    expect(DEFAULT_SVS_CONFIG.voice.startBudgetMs).toBe(2000);
    expect(DEFAULT_SVS_CONFIG.voice.wavlMinSessionS).toBe(30);
  });

  it('ships disabled with no rollout until explicitly enabled', () => {
    expect(DEFAULT_SVS_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SVS_CONFIG.rolloutPercent).toBe(0);
  });

  it('has a threshold and a preset for every voice intent', () => {
    for (const intent of VOICE_INTENTS) {
      expect(DEFAULT_SVS_CONFIG.classifier.thresholds[intent]).toBeGreaterThan(0);
      expect(PRESET_BY_INTENT[intent].presetId).toBeTruthy();
    }
  });

  it('uses Groq for LLM and STT, browser for TTS (ADR-004, ADR-005)', () => {
    expect(DEFAULT_SVS_CONFIG.llm.provider).toBe('groq');
    expect(DEFAULT_SVS_CONFIG.stt.provider).toBe('groq');
    expect(DEFAULT_SVS_CONFIG.tts.provider).toBe('browser');
  });

  it('lists every configured Groq model once', () => {
    const models = configuredGroqModels();
    expect(new Set(models).size).toBe(models.length);
    expect(models).toContain('openai/gpt-oss-20b');
    expect(models).toContain('whisper-large-v3-turbo');
  });
});
