declare module 'pdf-parse/lib/pdf-parse.js' {
  const pdf: (data: Buffer) => Promise<{ text: string; numpages: number }>;
  export default pdf;
}
