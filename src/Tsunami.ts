import { FileIndexer } from "./FileIndexer";
import { MutableTsunamiContext } from "./MutableTsunamiContext";
import { getErrorOutputForCommand } from "./Response";
import { writeOutputToStdOut } from "./ioUtils";
import { CommandInvoker } from "./CommandInvoker";
import { Command, CommandDefinition } from "./Command";
import { TsunamiContext } from "./Context";
import log from "./log";
import { UnknownObject, CallbackFunction } from "./types";
import * as JSONStream from "JSONStream";
import * as p from "child_process";
import * as es from "event-stream";
import * as fs from "fs";
import * as ts from "typescript";
import { TsProject } from "./tsProject";

function parseCommand(data: {[index: string]: any}): Command {
    if (data["command"] !== undefined && data["seq"] !== undefined) {
        return data as Command;
    } else {
        throw new Error("Invalid command format.");
    }
}

export class Tsunami {
    private terminalInvoker: CommandInvoker;
    private nonterminalInvoker: CommandInvoker;
    private documentRegistry: ts.DocumentRegistry;
    private context: TsunamiContext;

    constructor(
        private tsProject: TsProject,
        terminalCommandDefinitions: CommandDefinition<any>[],
        nonterminalCommandDefinitions: CommandDefinition<any>[]
    ) {
        this.terminalInvoker = new CommandInvoker(terminalCommandDefinitions);
        this.nonterminalInvoker = new CommandInvoker(nonterminalCommandDefinitions);
        this.documentRegistry = ts.createDocumentRegistry(true);
        this.context = new MutableTsunamiContext(
            this.tsProject,
            writeOutputToStdOut,
            this.documentRegistry
        );
    }

    public initialize() {
        log("initializing");
        this.buildRiggedTsServerProcess();
        this.indexDependenciesOfProject();
        this.buildInitialProjectIndex();
        log("initialized");
    }

    public buildRiggedTsServerProcess() {
        let tsserver: p.ChildProcess = p.spawn("node", ["/Users/amoreland/tsunami/node_modules/typescript/lib/tsserver.js"]);

        process.stdin.resume();
        process.stdin
            .pipe(JSONStream.parse(undefined))
            .pipe(es.map(this.processPotentialTsunamiCommand))
            .pipe(tsserver.stdin);

        tsserver.stdout
            .pipe(es.map((data: any, cb: CallbackFunction<any>) => {
                log(data);
                cb(null, data);
            }))
            .pipe(process.stdout);
    }

    public indexDependenciesOfProject(): Promise<void> {
        try {
            // ts.createLanguageService(ts.createCompilerHost(tsProject.getCompilerOptions(), true), GLOBAL_DOCUMENT_REGISTRY);
            return this.tsProject.getDependencyFilenames().then(deps => {
                log("Dependency typings: ", JSON.stringify(deps, null, 2));

                Object.keys(deps).forEach(dep => {
                    /* indexExternalModule(dep); */
                    try {
                        fs.accessSync(deps[dep]);
                        let typings = deps[dep];

                        if (typings) {
                            this.indexDefinitionFile(dep, typings);
                        }
                    } catch (e) {
                        log("Failed to index: ", dep);
                    }
                });
            }).catch(error => {
                log("Failed to get dependency filenames.");
                log(error.stack);
            });
        } catch (e) {
            log("Error during boot.");
            log(e.stack);
        }
    }

    public buildInitialProjectIndex(): Promise<void> {
        return this.tsProject.getFileNames().then(files => {
            let promises = files.map(file => {
                let p = this.context.getSourceFileFor(file).then(() => {
                    return this.context.reloadFile(file);
                });
                return p;
            });

            return Promise.all(promises).then(() => {
                log("Finished starting server.");
            });
        });
    }

    private processPotentialTsunamiCommand = (data: UnknownObject, cb: CallbackFunction<string>) => {
        // log("Incoming command: ", JSON.stringify(data, null, 2));
        let command = parseCommand(data);
        if (this.terminalInvoker.isInvokableCommand(command)) {
            // log("Processing command with tsunami.");
            try {
                this.terminalInvoker.invoke(this.context, command);
            } catch (e) {
                /* Prevents propagation of command to tsserver.stdin */
                log("Error processing tsunami command: ", JSON.stringify(command, null, 2), e.stack);
                writeOutputToStdOut<string>(getErrorOutputForCommand(command, e));
            }

            cb();
        } else {
            if (this.nonterminalInvoker.isInvokableCommand(command)) {
                // log("Wiretapping command with tsunami.");
                try {
                    this.nonterminalInvoker.invoke(this.context, command);
                } catch (e) {
                    log("Error wiretapping tsunami command: ", JSON.stringify(command, null, 2), e);
                }
            }
            // log("Proxying to tsserver: ", JSON.stringify(command, null, 2));
            /* Pass the re-string-form'd object straight through. */
            cb(null, JSON.stringify(command) + "\n");
        }
    }

    private indexDefinitionFile(moduleName: string, filename: string): Promise<void> {
        return this.context.getSourceFileFor(filename).then(() => {
            return this.context.updateSourceFileFor(filename).then(sourceFile => {
                log("Indexing definition file:", sourceFile.fileName);
                let indexer = new FileIndexer(sourceFile, (filename: string) => this.context.getSourceFileFor(filename));
                this.context.moduleIndexerMap[moduleName] = indexer;
                return indexer.indexFile();
            });
        });
    }
}
