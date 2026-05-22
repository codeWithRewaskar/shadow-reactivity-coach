# Changelog

All notable changes to Shadow Reactivity Coach are documented here.

## [2.1] - 2026-05-22

### Added
- Standalone SKILL.md for use in Claude, ChatGPT, and MCP without the Calming Paws app
- 10 example conversations demonstrating Shadow in action
- README with 3 install paths (Claude, ChatGPT, MCP)
- CC-BY-4.0 license for open knowledge sharing

### Changed
- Expanded breed knowledge base to 20 breed profiles with full reactivity-type breakdowns
- Enhanced RAG synonym map with 40+ colloquial phrase expansions (e.g. "goes crazy on leash" maps to barrier frustration)
- Improved three-type reactivity framework with diagnostic shortcuts and recovery time data

## [2.0] - 2026-04-15

### Added
- Three-type reactivity framework (fear / frustration / excitement) across all knowledge topics
- Breed-specific knowledge base: 20 breeds with reactivity profiles, training nuances, and threshold notes
- `get_breed_knowledge` tool for breed-aware personalisation
- Synonym-aware RAG scoring with multi-word phrase matching
- Frustration vs fear vs excitement identification topic with full diagnostic guide
- Cortisol vacation and nervous system reset topic
- Puppy prevention and socialisation topic
- 6 new breed profiles: Shetland Sheepdog, Australian Cattle Dog, Vizsla, French Bulldog, Poodle, Corgi

### Changed
- RAG pipeline moved server-side to Supabase edge function
- Knowledge base refactored into shared module (`knowledgeBase.ts`) imported by edge functions
- System prompt updated with breed-awareness rules and tool usage guidelines
- Guardrails strengthened with regex-based hard blocks for aversive and medical queries

## [1.0] - 2026-02-01

### Added
- Initial Shadow companion with 12 training knowledge topics
- System prompt with force-free-only rules and risk escalation
- RAG pipeline with keyword-based scoring
- 5 tools: `lookup_training_knowledge`, `get_recommended_exercises`, `get_dog_context`, `check_safety_level`, `get_training_resources`
- Floating chat UI with quick prompts and typing indicator
- Safety mode mapping (green/yellow/orange/red) based on risk level
- Guardrail footer on all responses
