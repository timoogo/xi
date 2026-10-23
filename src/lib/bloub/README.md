# Bloub attribution

Source: https://github.com/jeremy-prt/bloub
Revision: b4bb3c1b5f93c7b87a2e8d620f667c4093d97749
Copyright (c) 2026 Jérémy Perret — MIT (see LICENSE).

The framework-independent face.ts, math.ts, shape.ts, profiles.ts and skins.ts
are copied unchanged. BloubAvatar adapts the SVG geometry, projected gaze and
blinking to React. No Vue application or external service is imported.
appearance.ts defines the local deterministic v1 seed mapping. Keep that
mapping and the underlying geometry stable to preserve saved appearances.
Reduced motion and server rendering use the static rest pose.

The MIT license covers the upstream code, not the x.ai design it recreates.
This integration is not affiliated with x.ai.
