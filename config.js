// config.js
// DO NOT COMMIT THIS FILE TO VERSION CONTROL
// This file stores sensitive API keys and configuration for the FolloMe Agent.

export const config = {
    LLAMA_API_KEY: "YOUR_GROQ_API_KEY_HERE", // Add your actual API key here locally
    OPENROUTER_API_KEY: "YOUR_OPENROUTER_API_KEY_HERE", // Paste your Open Router API key here
    LLAMA_PROVIDER_URL: "https://api.groq.com/openai/v1/chat/completions",
    OPENROUTER_PROVIDER_URL: "https://openrouter.ai/api/v1/chat/completions",
    FAST_MODEL: "llama-3.1-8b-instant",
    FALLBACK_FAST_MODEL: "google/gemini-2.5-flash:free",
    COMPLEX_MODEL: "llama-3.3-70b-versatile",
    VISION_MODEL_UITARS: "bytedance/ui-tars-1.5-7b",
    PLANNING_MODEL_QWEN: "qwen/qwen-2.5-72b-instruct"
};
