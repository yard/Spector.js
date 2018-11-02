namespace SPECTOR {

    export interface ISpectorOptions {
        readonly injection?: InjectionType;
    }

    export interface IAvailableContext {
        readonly canvas: HTMLCanvasElement;
        readonly contextSpy: IContextSpy;
    }

    export class Spector {
        public static getFirstAvailable3dContext(canvas: HTMLCanvasElement): WebGLRenderingContexts {
            // Custom detection to run in the extension.
            return this.tryGetContextFromHelperField(canvas) ||
                this.tryGetContextFromCanvas(canvas, "webgl") ||
                this.tryGetContextFromCanvas(canvas, "experimental-webgl") ||
                this.tryGetContextFromCanvas(canvas, "webgl2") ||
                this.tryGetContextFromCanvas(canvas, "experimental-webgl2");
        }

        private static tryGetContextFromHelperField(canvas: HTMLCanvasElement): WebGLRenderingContexts {
            const type = canvas.getAttribute("__spector_context_type");
            if (type) {
                return this.tryGetContextFromCanvas(canvas, type);
            }

            return undefined;
        }

        private static tryGetContextFromCanvas(canvas: HTMLCanvasElement, type: string): WebGLRenderingContexts {
            let context: WebGLRenderingContexts;
            try {
                context = canvas.getContext(type) as WebGLRenderingContexts;
            }
            catch (e) {
                // Nothing to do here, canvas has not been found.;
            }
            return context;
        }

        public readonly onCaptureStarted: IEvent<any>;
        public readonly onCapture: IEvent<ICapture>;
        public readonly onError: IEvent<string>;

        private readonly logger: ILogger;
        private readonly timeSpy: ITimeSpy;
        private readonly contexts: IAvailableContext[];
        private readonly injection: InjectionType;
        private readonly time: ITime;

        private canvasSpy: ICanvasSpy;
        private captureNextFrames: number;
        private captureNextCommands: number;
        private quickCapture: boolean;
        private capturingContext: IContextSpy;
        private captureMenu: ICaptureMenu;
        private resultView: IResultView;
        private retry: number;
        private noFrameTimeout: NodeJS.Timer;
        private marker: string;

        constructor(private options: ISpectorOptions = {}) {
            this.injection = options.injection || ProvidedInjection.DefaultInjection;
            this.captureNextFrames = 0;
            this.captureNextCommands = 0;
            this.quickCapture = false;
            this.retry = 0;
            this.contexts = [];

            this.logger = new this.injection.LoggerCtor();
            this.time = new this.injection.TimeCtor();
            this.timeSpy = new this.injection.TimeSpyCtor({
                eventConstructor: this.injection.EventCtor,
                timeConstructor: this.injection.TimeCtor,
            }, this.logger);
            this.onCaptureStarted = new this.injection.EventCtor<ICapture>();
            this.onCapture = new this.injection.EventCtor<ICapture>();
            this.onError = new this.injection.EventCtor<string>();

            this.timeSpy.onFrameStart.add(this.onFrameStart, this);
            this.timeSpy.onFrameEnd.add(this.onFrameEnd, this);
            this.timeSpy.onError.add(this.onErrorInternal, this);
        }

        public displayUI() {
            if (!this.captureMenu) {
                this.getCaptureUI();

                this.captureMenu.onPauseRequested.add(this.pause, this);
                this.captureMenu.onPlayRequested.add(this.play, this);
                this.captureMenu.onPlayNextFrameRequested.add(this.playNextFrame, this);
                this.captureMenu.onCaptureRequested.add((info) => {
                    if (info) {
                        this.captureCanvas(info.ref);
                    }
                }, this);

                setInterval(() => { this.captureMenu.setFPS(this.getFps()); }, 1000);
                this.captureMenu.trackPageCanvases();

                this.captureMenu.display();
            }

            if (!this.resultView) {
                this.getResultUI();

                this.onCapture.add((capture) => {
                    this.resultView.display();
                    this.resultView.addCapture(capture);
                });
            }
        }

        public getResultUI(): IResultView {
            if (!this.resultView) {
                this.resultView = new this.injection.ResultViewConstructor({
                    eventConstructor: this.injection.EventCtor,
                }, this.logger);
                this.resultView.onSourceCodeChanged.add((sourceCodeEvent) => {
                    this.rebuildProgramFromProgramId(sourceCodeEvent.programId,
                        sourceCodeEvent.sourceVertex,
                        sourceCodeEvent.sourceFragment,
                        (program) => {
                            this.referenceNewProgram(sourceCodeEvent.programId, program);
                            this.resultView.showSourceCodeError(null);
                        },
                        (error) => {
                            this.resultView.showSourceCodeError(error);
                        });
                });
            }
            return this.resultView;
        }

        public getCaptureUI(): ICaptureMenu {
            if (!this.captureMenu) {
                this.captureMenu = new this.injection.CaptureMenuConstructor({
                    eventConstructor: this.injection.EventCtor,
                }, this.logger);
            }
            return this.captureMenu;
        }

        public rebuildProgramFromProgramId(programId: number,
            vertexSourceCode: string,
            fragmentSourceCode: string,
            onCompiled: (program: WebGLProgram) => void,
            onError: (message: string) => void) {

            const program = SPECTOR.WebGlObjects.Program.getFromGlobalStore(programId);

            this.rebuildProgram(program,
                vertexSourceCode,
                fragmentSourceCode,
                onCompiled,
                onError,
            );
        }

        public rebuildProgram(program: WebGLProgram,
            vertexSourceCode: string,
            fragmentSourceCode: string,
            onCompiled: (program: WebGLProgram) => void,
            onError: (message: string) => void) {
            ProgramRecompilerHelper.rebuildProgram(program,
                vertexSourceCode,
                fragmentSourceCode,
                onCompiled,
                onError,
            );
        }

        public referenceNewProgram(programId: number, program: WebGLProgram): void {
            SPECTOR.WebGlObjects.Program.updateInGlobalStore(programId, program);
        }

        public pause(): void {
            this.timeSpy.changeSpeedRatio(0);
        }

        public play(): void {
            this.timeSpy.changeSpeedRatio(1);
        }

        public playNextFrame(): void {
            this.timeSpy.playNextFrame();
        }

        public drawOnlyEveryXFrame(x: number): void {
            this.timeSpy.changeSpeedRatio(x);
        }

        public getFps(): number {
            return this.timeSpy.getFps();
        }

        public spyCanvases(): void {
            if (this.canvasSpy) {
                this.onErrorInternal("Already spying canvas.");
                return;
            }

            this.canvasSpy = new this.injection.CanvasSpyCtor({ eventConstructor: this.injection.EventCtor }, this.logger);
            this.canvasSpy.onContextRequested.add(this.spyContext, this);
        }

        public spyCanvas(canvas: HTMLCanvasElement): void {
            if (this.canvasSpy) {
                this.onErrorInternal("Already spying canvas.");
                return;
            }

            this.canvasSpy = new this.injection.CanvasSpyCtor({
                eventConstructor: this.injection.EventCtor,
                canvas,
            }, this.logger);
            this.canvasSpy.onContextRequested.add(this.spyContext, this);
        }

        public getAvailableContexts(): IAvailableContext[] {
            return this.getAvailableContexts();
        }

        public captureCanvas(canvas: HTMLCanvasElement,
            commandCount = 0,
            quickCapture: boolean = false): void {

            const contextSpy = this.getAvailableContextSpyByCanvas(canvas);
            if (!contextSpy) {
                const context = Spector.getFirstAvailable3dContext(canvas);
                if (context) {
                    this.captureContext(context, commandCount, quickCapture);
                }
                else {
                    this.logger.error("No webgl context available on the chosen canvas.");
                }
            }
            else {
                this.captureContextSpy(contextSpy, commandCount, quickCapture);
            }
        }

        public captureContext(context: WebGLRenderingContexts,
            commandCount = 0,
            quickCapture: boolean = false): void {

            let contextSpy = this.getAvailableContextSpyByCanvas(context.canvas);

            if (!contextSpy) {
                if ((context as WebGL2RenderingContext).getIndexedParameter) {
                    contextSpy = new this.injection.ContextSpyCtor({
                        context,
                        version: 2,
                        recordAlways: false,
                        injection: this.injection,
                    }, this.time, this.logger);
                }
                else {
                    contextSpy = new this.injection.ContextSpyCtor({
                        context,
                        version: 1,
                        recordAlways: false,
                        injection: this.injection,
                    }, this.time, this.logger);
                }

                contextSpy.onMaxCommand.add(this.stopCapture, this);

                this.contexts.push({
                    canvas: contextSpy.context.canvas,
                    contextSpy,
                });
            }

            if (contextSpy) {
                this.captureContextSpy(contextSpy, commandCount, quickCapture);
            }
        }

        public captureContextSpy(contextSpy: IContextSpy,
            commandCount = 0,
            quickCapture: boolean = false): void {

            this.quickCapture = quickCapture;

            if (this.capturingContext) {
                this.onErrorInternal("Already capturing a context.");
            }
            else {
                this.retry = 0;
                this.capturingContext = contextSpy;
                this.capturingContext.setMarker(this.marker);

                // Limit command count to 5000 record.
                commandCount = Math.min(commandCount, 5000);
                if (commandCount > 0) {
                    this.captureCommands(commandCount);
                }
                else {
                    // Capture only one frame.
                    this.captureFrames(1);
                }

                this.noFrameTimeout = setTimeout(() => {
                    if (commandCount > 0) {
                        this.stopCapture();
                    }
                    else if (this.capturingContext && this.retry > 1) {
                        this.onErrorInternal("No frames with gl commands detected. Try moving the camera.");
                    }
                    else {
                        this.onErrorInternal("No frames detected. Try moving the camera or implementing requestAnimationFrame.");
                    }
                }, 10 * 1000);
            }
        }

        public captureNextFrame(obj: HTMLCanvasElement | WebGLRenderingContexts,
            quickCapture: boolean = false): void {

            if (obj instanceof HTMLCanvasElement) {
                this.captureCanvas(obj, 0, quickCapture);
            }
            else {
                this.captureContext(obj, 0, quickCapture);
            }
        }

        public startCapture(obj: HTMLCanvasElement | WebGLRenderingContexts,
            commandCount: number,
            quickCapture: boolean = false): void {

            if (obj instanceof HTMLCanvasElement) {
                this.captureCanvas(obj, commandCount, quickCapture);
            }
            else {
                this.captureContext(obj, commandCount, quickCapture);
            }
        }

        public stopCapture(): ICapture {
            if (this.capturingContext) {
                const capture = this.capturingContext.stopCapture();
                if (capture.commands.length > 0) {
                    if (this.noFrameTimeout !== null) {
                        clearTimeout(this.noFrameTimeout);
                    }
                    this.triggerCapture(capture);

                    this.capturingContext = undefined;
                    this.captureNextFrames = 0;
                    this.captureNextCommands = 0;
                    return capture;
                }
                else if (this.captureNextCommands === 0) {
                    this.retry++;
                    this.captureFrames(1);
                }
            }
            return undefined;
        }

        public setMarker(marker: string): void {
            this.marker = marker;
            if (this.capturingContext) {
                this.capturingContext.setMarker(marker);
            }
        }

        public clearMarker(): void {
            this.marker = null;
            if (this.capturingContext) {
                this.capturingContext.clearMarker();
            }
        }

        private captureFrames(frameCount: number): void {
            this.captureNextFrames = frameCount;
            this.captureNextCommands = 0;

            this.playNextFrame();
        }

        private captureCommands(commandCount: number): void {
            this.captureNextFrames = 0;
            this.captureNextCommands = commandCount;

            this.play();

            if (this.capturingContext) {
                this.onCaptureStarted.trigger(undefined);
                this.capturingContext.startCapture(commandCount, this.quickCapture);
            }
            else {
                this.onErrorInternal("No context to capture from.");
                this.captureNextCommands = 0;
            }
        }

        private spyContext(contextInformation: IContextInformation) {
            let contextSpy = this.getAvailableContextSpyByCanvas(contextInformation.context.canvas);
            if (!contextSpy) {
                contextSpy = new this.injection.ContextSpyCtor({
                    context: contextInformation.context,
                    version: contextInformation.contextVersion,
                    recordAlways: true,
                    injection: this.injection,
                }, this.time, this.logger);

                contextSpy.onMaxCommand.add(this.stopCapture, this);

                this.contexts.push({
                    canvas: contextSpy.context.canvas,
                    contextSpy,
                });
            }

            contextSpy.spy();
        }

        private getAvailableContextSpyByCanvas(canvas: HTMLCanvasElement): IContextSpy {
            for (const availableContext of this.contexts) {
                if (availableContext.canvas === canvas) {
                    return availableContext.contextSpy;
                }
            }
            return undefined;
        }

        private onFrameStart(): void {
            if (this.captureNextCommands > 0) {
                // Nothing to do here but preventing to drop the capturing context.
            }
            else if (this.captureNextFrames > 0) {
                if (this.capturingContext) {
                    this.onCaptureStarted.trigger(undefined);
                    this.capturingContext.startCapture(0, this.quickCapture);
                }
                this.captureNextFrames--;
            }
            else {
                this.capturingContext = undefined;
            }
        }

        private onFrameEnd(): void {
            if (this.captureNextCommands > 0) {
                // Nothing to do here but preventing to drop the capturing context.
            }
            else if (this.captureNextFrames === 0) {
                this.stopCapture();
            }
        }

        private triggerCapture(capture: ICapture) {
            if (this.captureMenu) {
                this.captureMenu.captureComplete(null);
            }
            this.onCapture.trigger(capture);
        }

        private onErrorInternal(error: string) {
            this.logger.error(error);
            if (this.noFrameTimeout !== null) {
                clearTimeout(this.noFrameTimeout);
            }

            if (this.capturingContext) {
                this.capturingContext = undefined;
                this.captureNextFrames = 0;
                this.captureNextCommands = 0;
                this.retry = 0;

                if (this.captureMenu) {
                    this.captureMenu.captureComplete(error);
                }
                this.onError.trigger(error);
            }
            else {
                throw error;
            }
        }
    }
}
