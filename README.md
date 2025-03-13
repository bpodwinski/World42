![planet-quadtree-js-web-web-worker](https://github.com/user-attachments/assets/bbbdd36f-db09-4105-9a1c-66f747aadccc)

# World42

World42 is a high-performance, multithreaded planet rendering engine that leverages a quadtree structure to dynamically manage Levels of Detail (LOD) for planetary surfaces. The project uses Web Workers for heavy geometry calculations and a floating-origin system to maintain precision even at vast distances.

## Overview

World42 is designed to render detailed, textured planetary surfaces with efficient LOD management. It uses a custom quadtree structure to subdivide the planet's surface and dynamically update patches based on the camera's distance and movement. By offloading geometry calculations to Web Workers, the engine maintains a smooth, responsive user experience.

## Features

- **Dynamic LOD Management:**  
  Efficiently subdivides and replaces patches based on camera proximity to ensure high detail where needed.

- **Multithreading with Web Workers:**  
  Offloads intensive geometry computations to separate threads for improved performance.

- **Floating-Origin System:**  
  Uses a floating-origin camera system to maintain precision over large distances.

- **Optimized Quadtree Structure:**  
  Organizes planetary patches in a hierarchical quadtree, allowing for fast LOD updates and rendering.

- **Custom Shader Materials:**  
  Applies shader-based materials to patches for realistic texturing and lighting effects.

## Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/bpodwinski/World42.git
   cd World42
