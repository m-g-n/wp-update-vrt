export class ContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ContractError'
  }
}

// 空の結果を公開しないための停止。code はログに出るので、固定の語だけを使う
export class GuardError extends Error {
  constructor(code) {
    super(code)
    this.name = 'GuardError'
    this.code = code
  }
}
