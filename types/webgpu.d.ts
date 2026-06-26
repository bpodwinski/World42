// WebGPU ambient global types (GPUFeatureName, GPUBuffer, GPUDevice, ...).
// Babylon.js 8 pulled @webgpu/types in transitively; Babylon 9 no longer does,
// so we declare it explicitly here. World42 is a WebGPU-first renderer and uses
// these globals directly (e.g. engine_manager's deviceDescriptor.requiredFeatures).
/// <reference types="@webgpu/types" />
