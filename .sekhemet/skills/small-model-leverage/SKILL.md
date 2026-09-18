---
name: small-model-leverage
description: Optimization strategies for 3B-30B local models matching frontier capabilities
triggers: ["small", "model", "local", "ollama", "tokens"]
budgetTokens: 250
---
# Small Model Leverage Guide

1. **Avoid Format Tax:** Rely on flat scalar tool arguments (Arm A) or standard search/replace delimiters (Arm C).
2. **Concise Reasoning:** Do not output long conversational preambles. Call tools directly.
3. **Byte Stability:** Keep system prompt instructions fixed to allow local inference engines (Ollama, llama.cpp) to hit KV prefix cache.
4. **Step Budget:** Plan actions to finish within 15–25 turns.
