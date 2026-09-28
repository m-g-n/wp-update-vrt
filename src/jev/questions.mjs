// 質問は「安全か」ではなく「何が起きるか」の形にする。結論はコード側（score）が出す。
// 英語で書く（公式が英語で最高精度と明言している）
export const QUESTIONS = {
  emits_markup: {
    type: 'noul',
    instructions: 'Does this PHP code change alter the HTML markup, element structure, or CSS class/id names that the plugin outputs to public website visitors?',
    criteria: {
      true: 'Visitor-facing HTML, attributes, or class/id names change',
      false: 'Only internal logic, admin-only output, or no change to visitor-facing HTML',
    },
  },
  runs_on_front: {
    type: 'noul',
    instructions: 'Does this JavaScript run on public website pages, not only inside the WordPress admin dashboard or block editor?',
  },
  mutates_dom: {
    type: 'noul',
    instructions: 'Does this JavaScript change add, remove, move, or restyle page elements, inline styles, or CSS class names in the browser?',
  },
}
