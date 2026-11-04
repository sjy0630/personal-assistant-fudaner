declare module 'pdf-parse/lib/pdf-parse.js' {
  const pdf: (data: Buffer) => Promise<{ text: string; numpages: number }>;
  export default pdf;
}

/** electron-vite：以 ?asset 结尾的导入得到文件的运行时绝对路径 */
declare module '*?asset' {
  const path: string;
  export default path;
}
declare module '*?asset&asarUnpack' {
  const path: string;
  export default path;
}
