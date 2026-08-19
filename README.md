# Abir Dev — Ocean Portfolio

🌊 **[Live site → abirmehmed.github.io/ocean-portfolio](https://abirmehmed.github.io/ocean-portfolio/)**

A real-time, fully procedural ocean rendered with **WebGPU** and **Three.js TSL**, doubling as my portfolio. No textures, no HDRI, no video — the water, sky, weather, and lighting are all generated on the GPU.

### Highlights
- Five analytic Gerstner waves with closed-form (not neighbour-sampled) normals
- Animated gradient-noise FBM for capillary ripple detail
- One shared analytic sky function driving the sky dome *and* the water's reflections/haze
- Dynamic time of day, sea state, rain, and thunder — with synthesized audio (no sound files)
- TSL bloom + ACES tone mapping
- A glassmorphic tab UI (About / Work / Contact) layered on top, built with plain HTML/CSS/JS — no framework, no build step

### Stack
`WebGPU` · `Three.js` · `TSL` · vanilla JS/HTML/CSS

### Run it locally
```bash
git clone https://github.com/abirmehmed/ocean-portfolio.git
cd ocean-portfolio
npx serve .        # or: python3 -m http.server
```
Open the printed `localhost` URL in Chrome, Edge, or Safari 18+ (WebGPU required).

---
© 2026 Abir Dev
