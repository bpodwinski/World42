# Floating-Origin Camera Test for Babylon.js

## Overview
This project is a **test implementation of a Floating-Origin camera system** for **Babylon.js**, combined with a **real-scale Solar System simulation**. The main goal is to mitigate floating-point precision issues when rendering vast distances by keeping the camera fixed at the origin and moving all celestial bodies relative to it.

## Features
### **Floating-Origin Camera (`OriginCamera`)**
- The camera stays at `(0,0,0)`, while objects move around it.
- Uses **double precision positioning (`doublepos`)** to store accurate locations.
- Avoids floating-point inaccuracies when rendering astronomical distances.

### **Real-Scale Solar System**
- Uses a **scale manager (`ScaleManager`)** to convert real-world distances (km) into simulation units.
- Example: `1 Babylon.js unit = 1000 km`.
- The scene currently includes:
  - **The Sun** (light source with emissive material)
  - **Pluto** (PBR material with real textures)
  - **(Mercury and Venus are commented but ready to be enabled)**

## Why Use Floating-Origin?
When simulating the **real-scale Solar System**, we face a major issue:
- **Floating-point precision loss** at extremely large distances.
- Example: Pluto is at **5.9 billion km** from the Sun, causing position inaccuracies in standard Babylon.js rendering.

## Installation & Usage
1. Clone the repository:
   ```bash
   git clone https://github.com/bpodwinski/Floating-Origin-Babylon.js.git
   cd floating-origin-babylonjs
   ```
2. Install dependencies:
   ```bash
   npm i
   ```
3. Run the project:
   ```bash
   npm run dev
   ```
4. Open your browser and navigate to `http://localhost:5173`

## Credits
Built with **Babylon.js**: https://doc.babylonjs.com/features/featuresDeepDive/scene/floating_origin
