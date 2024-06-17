// custom.d.ts
declare global {
  type ImageData = any;
  type HTMLCanvasElement = any;
  type HTMLVideoElement = any;
  type ReadableStream = any;
}

// custom.d.ts this include reviewed referencing ensuring no skipped handling
declare module '@cesdk/node' {
  export type MimeType = any;
}


// If needed, export the declaration
export { };