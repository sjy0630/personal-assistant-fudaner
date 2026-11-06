import { describe, expect, it } from 'vitest';
import { pdfLayout, pdfPageToMarkdown, wordToMarkdown, type PdfTextItem, type WordNode } from '../src/main/library/structure';
const text = (value: string): WordNode => ({ type: 'text', value });
const paragraph = (value: string, extra: Partial<WordNode> = {}): WordNode => ({ type: 'paragraph', children: [text(value)], ...extra });
const item = (str: string, x: number, y: number, size = 10): PdfTextItem => ({ str, transform: [size,0,0,size,x,y], width: str.length*5, height: size });
describe('文档结构提取', () => {
  it('Word 保留中英文标题、段落和嵌套列表', () => {
    const document: WordNode = { type: 'document', children: [paragraph('主标题', { styleName: 'Heading 1' }), paragraph('次标题', { styleName: '标题 2' }), paragraph('正文'), paragraph('一级', { numbering: { level: 0, isOrdered: false } }), paragraph('二级', { numbering: { level: 1, isOrdered: true } })] };
    const result = wordToMarkdown(document);
    expect(result).toContain('# 主标题\n\n## 次标题\n\n正文');
    expect(result).toContain('- 一级\n  1. 二级');
  });
  it('Word 表格保留空单元格、单元格内段落与竖线', () => {
    const table: WordNode = { type: 'table', children: [
      { type: 'tableRow', children: [{ type: 'tableCell', children: [paragraph('名称')] }, { type: 'tableCell', children: [paragraph('内容')] }] },
      { type: 'tableRow', children: [{ type: 'tableCell', children: [] }, { type: 'tableCell', children: [paragraph('A|B'), paragraph('下一段')] }] },
    ] };
    expect(wordToMarkdown(table)).toBe('| 名称 | 内容 |\n| --- | --- |\n|  | A\\|B / 下一段 |');
  });
  it('PDF 将乱序片段按位置重排并补充单词间隔', () => {
    const result = pdfPageToMarkdown([item('world', 80, 100), item('Hello', 50, 100), item('下一段。',50,60)], 2);
    expect(result).toContain('Hello world'); expect(result).toContain('第 2 页'); expect(result).toContain('下一段。');
  });
  it('PDF 合并普通换行，保留段落间隔', () => {
    expect(pdfPageToMarkdown([item('这是同一',50,100), item('段正文。',50,86), item('这是下一段。',50,60)], 1)).toContain('这是同一段正文。\n\n这是下一段。');
  });
  it('PDF 恢复跨行表格的列与缺少底边的末行', () => {
    const items = [item('名称',50,210),item('说明',180,210),item('甲',50,180),item('第一行',180,180),item('续行',180,165),item('乙',50,140),item('第二行',180,140)];
    const layout = pdfLayout(items, { fnArray:[91,91,91,91], argsArray:[[[19],[40,200,120,1]],[[19],[160,200,200,1]],[[19],[40,150,120,1]],[[19],[160,150,200,1]]] });
    expect(layout.tables).toHaveLength(1);
    const result=pdfPageToMarkdown(items,1,layout);
    expect(result).toContain('| 甲 | 第一行续行 |'); expect(result).toContain('| 乙 | 第二行 |');
    expect(result.match(/第一行/g)).toHaveLength(1);
  });
  it('PDF 不把短链接下划线识别成表格', () => {
    expect(pdfLayout([item('链接',50,100)], {fnArray:[91,91],argsArray:[[[19],[50,90,40,1]],[[19],[90,90,30,1]]]}).tables).toHaveLength(0);
  });
  it('空白 PDF 页给出说明', () => { expect(pdfPageToMarkdown([],3)).toContain('第 3 页：未提取到文字'); });
});
