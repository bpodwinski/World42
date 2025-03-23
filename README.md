![planet-quadtree-js-web-web-worker](https://github.com/user-attachments/assets/bbbdd36f-db09-4105-9a1c-66f747aadccc)

# World42

World42 is a high-performance, multithreaded planet rendering engine that leverages a quadtree structure to dynamically manage Levels of Detail (LOD) for planetary surfaces. The project uses Web Workers for heavy geometry calculations and a floating-origin system to maintain precision even at vast distances. World42 is designed to render detailed, textured planetary surfaces with efficient LOD management. It uses a custom quadtree structure to subdivide the planet's surface and dynamically update patches based on the camera's distance and movement. By offloading geometry calculations to Web Workers, the engine maintains a smooth, responsive user experience.

## Features
- Floating origin camera
- Real-scale planet (1:1)
- Quadsphere with a uniform mesh
- Asynchronous CDLOD/Quadtree using Web Workers

## Demo
[https://bpodwinski.github.io/World42/](https://bpodwinski.github.io/World42/)
- Press L to display LODs
- Press ² to display BabylonJS debug layer

## Installation
### Prerequisites

- [Node.js](https://nodejs.org/)
- [npm](https://www.npmjs.com/)
- [Vite](https://vitejs.dev/)

**Clone the repository:**

   ```bash
   git clone https://github.com/bpodwinski/World42.git
   cd World42
