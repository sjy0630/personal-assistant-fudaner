import type { Memory } from '../../shared/types';

/** 忽略排版差异，不做语义猜测，避免把相反偏好或不同数值合并。 */
export function memoryKey(content: string): string {
  return content.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, mark => /[-.:/]/.test(mark) ? mark : '').replace(/^(?:用户|我)/u, '');
}

/** 宁可少记：只接受本轮用户明确陈述的原话片段，不接受问题、假设或助理建议。 */
export function memoryWriteProblem(userText: string, content: string, existing: readonly Pick<Memory, 'content'>[]): string | undefined {
  const key = memoryKey(content);
  if (key.length < 3) return '没有可核实的用户事实，未写入记忆。';
  if (existing.some(memory => memoryKey(memory.content) === key)) return '这条信息已有记忆，无需重复写入。';
  const supported = userText.split(/(?<=[。！？!?；;，,])|\n/u).some(part => {
    const clause = part.trim();
    if (!clause || /^[“”"'「『>]/u.test(clause)) return false;
    if (/[?？]|哪些|什么|是否|怎么|如何|能否|请问|有没有|例如|比如|假设|假如|如果|的话|原文|示例|我听说|我引用|我转述|\b(?:if|suppose|example|what|whether)\b/iu.test(clause)) return false;
    if (!/^(?:我|本人|请记住|记住|以后|每(?:周|天|月|年)|周[一二三四五六日天]|i\b|my\b|please remember\b|remember\b|every\b)/iu.test(clause)) return false;
    const source = memoryKey(clause);
    const index = source.indexOf(key);
    if (index < 0) return false;
    // “我不喜欢咖啡”不能被截成“喜欢咖啡”。否定必须保留在记忆正文中。
    return !/[不没未无别勿非]|not|never|dont|cannot|doesnt/iu.test(source.slice(0, index));
  });
  return supported ? undefined : '记忆内容必须是本轮用户明确陈述的原话，不能来自问题、已有记忆、工具结果或助理建议；未写入。';
}
