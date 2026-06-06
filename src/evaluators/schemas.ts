// JSON Schemas for structured output (response_format.json_schema).
// Each evaluator defines its expected shape here so we can pass it to providers
// that support OpenAI's strict json_schema format (OpenAI, Groq, Together,
// Fireworks, vLLM, etc.). All schemas set `additionalProperties: false` so
// the provider refuses any field the evaluator didn't declare.
//
// These schemas are sent ONLY when config.structured_output === true.
// Chrome backend ignores them (its own responseConstraint path).
//
// Schema NAMES must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/ per OpenAI's spec.

const EVIDENCE_ITEM = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    url: { type: 'string' },
    snippet: { type: 'string' },
  },
  required: ['title', 'url'],
  additionalProperties: false,
} as const

const RISK_FLAG = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    description: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['type', 'description', 'severity'],
  additionalProperties: false,
} as const

const PREFERENCE_CONFLICT = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['category', 'expected', 'actual', 'severity'],
  additionalProperties: false,
} as const

const ESTIMATED_RANGE = {
  type: 'object',
  properties: {
    min: { type: 'number' },
    max: { type: 'number' },
    currency: { type: 'string' },
  },
  required: ['min', 'max', 'currency'],
  additionalProperties: false,
} as const

export const JOB_FIT_SCHEMA = {
  type: 'object',
  properties: {
    skill_match: { type: 'number' },
    experience_match: { type: 'number' },
    overall_fit: { type: 'number' },
    matching_skills: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    evidences: { type: 'array', items: EVIDENCE_ITEM },
  },
  required: [
    'skill_match',
    'experience_match',
    'overall_fit',
    'matching_skills',
    'gaps',
    'strengths',
    'summary',
    'evidences',
  ],
  additionalProperties: false,
} as const

export const SALARY_SCHEMA = {
  type: 'object',
  properties: {
    estimated_range: ESTIMATED_RANGE,
    expectation_alignment: { type: 'string', enum: ['below', 'within', 'above'] },
    risk_flag: { type: 'boolean' },
    reasoning: { type: 'string' },
    evidences: { type: 'array', items: EVIDENCE_ITEM },
  },
  required: ['estimated_range', 'expectation_alignment', 'risk_flag', 'reasoning', 'evidences'],
  additionalProperties: false,
} as const

export const PREFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    alignment_score: { type: 'number' },
    conflicts: { type: 'array', items: PREFERENCE_CONFLICT },
    matches: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    evidences: { type: 'array', items: EVIDENCE_ITEM },
  },
  required: ['alignment_score', 'conflicts', 'matches', 'summary', 'evidences'],
  additionalProperties: false,
} as const

export const RISK_SCHEMA = {
  type: 'object',
  properties: {
    overall_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    flags: { type: 'array', items: RISK_FLAG },
    summary: { type: 'string' },
    evidences: { type: 'array', items: EVIDENCE_ITEM },
  },
  required: ['overall_risk', 'flags', 'summary', 'evidences'],
  additionalProperties: false,
} as const

export const GROWTH_SCHEMA = {
  type: 'object',
  properties: {
    learning_opportunity: { type: 'number' },
    brand_value: { type: 'number' },
    career_trajectory: { type: 'number' },
    overall_growth: { type: 'number' },
    highlights: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    evidences: { type: 'array', items: EVIDENCE_ITEM },
  },
  required: [
    'learning_opportunity',
    'brand_value',
    'career_trajectory',
    'overall_growth',
    'highlights',
    'concerns',
    'summary',
    'evidences',
  ],
  additionalProperties: false,
} as const

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    job_summary: { type: 'string' },
    reasoning: { type: 'string' },
  },
  required: ['job_summary', 'reasoning'],
  additionalProperties: false,
} as const
