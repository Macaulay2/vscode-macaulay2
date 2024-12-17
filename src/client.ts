import {
    Executable,
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from 'vscode-languageclient/node';

const serverOptions: ServerOptions = <Executable>{
    command: "M2-language-server"};

const clientOptions: LanguageClientOptions = {};

export default new LanguageClient(
    "macaulay2-language-server",
    serverOptions,
    clientOptions);
