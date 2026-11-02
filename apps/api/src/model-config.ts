import type { Env } from '../../../packages/contracts/src/index';
import { hostedPolicy } from './model-runtime';

export interface ModelReadiness {
  model: string;
  modelName: string;
  modelReady: boolean;
  modelStatus: 'mock' | 'configured' | 'not_configured';
  readinessError?: string;
}

/** Configuration readiness is distinct from a successful provider/API test. */
export function modelReadiness(env: Env): ModelReadiness {
  if (env.MODEL_PROVIDER === 'mock') {
    return { model: 'mock', modelName: 'mock', modelReady: true, modelStatus: 'mock' };
  }
  const unavailable = (code: string): ModelReadiness => ({
    model: env.MODEL_PROVIDER, modelName: 'not_configured', modelReady: false,
    modelStatus: 'not_configured', readinessError: code,
  });
  if (env.MODEL_PROVIDER !== 'openai') return unavailable('unsupported_model_provider');
  if (env.LIVE_MODEL_ENABLED !== 'true') return unavailable('live_model_not_enabled');
  if (!env.OPENAI_API_KEY?.trim()) return unavailable('model_key_missing');
  try {
    const policy = hostedPolicy(env);
    return { model: 'openai', modelName: policy.model, modelReady: true, modelStatus: 'configured' };
  } catch { return unavailable('model_configuration_invalid'); }
}
