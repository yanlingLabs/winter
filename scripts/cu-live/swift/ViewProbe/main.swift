import Foundation

// Arguments and the self-test come first and never touch the socket.
switch ProbeArgs.parse(Array(CommandLine.arguments.dropFirst())) {
case .failure(let error):
    FileHandle.standardError.write(Data("cu-live-viewprobe: \(error.message)\n\(ProbeArgs.usage)\n".utf8))
    exit(ProbeExit.failed)
case .success(.help):
    print(ProbeArgs.usage)
    exit(0)
case .success(.selfTest):
    exit(runProbeSelfTest())
case .success(.run(let options)):
    ProbeClient(options: options).run()
}
