/** Customer-facing model text with line breaks and safe, limited bold emphasis. */
export function ReplyText({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`output reply${compact ? " reply-compact" : ""}`}>{text.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? <strong key={index}>{part.slice(2, -2)}</strong> : part,
  )}</div>;
}
