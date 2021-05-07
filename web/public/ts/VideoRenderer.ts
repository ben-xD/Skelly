import {
    BufferAttribute,
    BufferGeometry,
    Camera, Color,
    OrthographicCamera,
    Points,
    PointsMaterial,
    Scene,
    WebGLRenderer
} from "three";
import MediapipeHolisticCalculator from "./MediapipeHolisticCalculator";
import Stats from 'stats.js'
import Messaging from "./Messaging";
import UserMedia from "./models/UserMedia";
import {Direction} from "./models/Direction";
import {Results} from "@mediapipe/holistic";
import {pickRandomTailwindColorHex} from "./name_utilities";

/**
 * Renders video to a three.js renderer periodically based on its internal state.
 * Update this state to change the render output for the next frame.
 * There are multiple types of state, such as local user's face mesh, remote user's data, and perhaps more to come (objects).
 */
export default class VideoRenderer {
    videoElement: HTMLVideoElement
    private scene: Scene
    private camera: Camera
    private renderer: WebGLRenderer
    private messaging: Messaging
    renderId: number | null = null
    private isRunning: Boolean
    private readonly aspectRatio: number;
    private fpsOutput: HTMLParagraphElement;
    private holisticCalculator: MediapipeHolisticCalculator;
    private readonly width: number;
    private readonly height: number;
    private meshPoints: Points<BufferGeometry, PointsMaterial>;
    private stats: Stats;
    private latestLandmarks: Float32Array | null = null;
    private periodicFaceData: number;
    private readonly cameraWidth: number;
    private readonly cameraHeight: number;
    private faceMeshColor: string = pickRandomTailwindColorHex();
    private uploadFramesPerSecond: number;

    constructor(videoElement: HTMLVideoElement,
                outputElement: HTMLDivElement,
                fpsOutput: HTMLDivElement,
                messaging: Messaging,
                width = 680,
                cameraWidth = 200,
                aspectRatio = 680 / 480,
                uploadFramesPerSecond = 2
    ) {
        this.videoElement = videoElement;
        outputElement.innerHTML = "";
        this.fpsOutput = fpsOutput;
        this.messaging = messaging;
        this.aspectRatio = aspectRatio
        this.width = width
        this.height = width / this.aspectRatio
        this.cameraWidth = cameraWidth
        this.cameraHeight = cameraWidth / this.aspectRatio
        this.uploadFramesPerSecond = uploadFramesPerSecond

        this.stats = new Stats()
        this.stats.dom.style.cssText = "position:relative;top:0;left:0;cursor:pointer;opacity:0.9;z-index:10000"
        this.stats.showPanel(0);
        this.fpsOutput.appendChild(this.stats.dom)

        this.renderer = new WebGLRenderer({alpha: true});
        this.renderer.setClearColor(0xEEF2FF, 1)
        this.renderer.setSize(this.width, this.height);
        this.renderer.domElement.style.borderRadius = "16px"
        outputElement.appendChild(this.renderer.domElement)
        this.scene = new Scene();
        this.camera = new OrthographicCamera(
            0,
            this.aspectRatio * 450,
            450,
            0,
            -1000,
            1000);

        const scaleFactor = 1
        this.holisticCalculator = new MediapipeHolisticCalculator(
            this.updateScene,
            this.width * scaleFactor,
            this.height * scaleFactor
        );
        if (videoElement.readyState != 4) { // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState
            videoElement.addEventListener('canplay', async () => {
                await this.start()
            }, {once: true})
        } else {
            this.start()
        }

        this.setupKeyControls()
    }

    updateUsername = (username: string) => {
        console.error("TODO: render the username")
    }

    scheduleFaceDataPublishing() {
        window.clearInterval(this.periodicFaceData)
        const intervalInMilliseconds = 1000 / this.uploadFramesPerSecond
        this.periodicFaceData = window.setInterval(async () => {
            if (this.latestLandmarks) {
                await this.messaging.publishToLobby(this.latestLandmarks, this.faceMeshColor);
            }
        }, intervalInMilliseconds)
    }

    cancelFaceDataPublishing() {
        window.clearInterval(this.periodicFaceData)
    }

    start = async () => {
        this.isRunning = true
        this.stats.begin()
        await this.step()
    }

    /**
     * Call this to start the rendering
     */
    step = async () => {
        if (this.isRunning) {
            this.isRunning = true
            await this.holisticCalculator.send(this.videoElement) //  continues in [MediaPipeFaceMeshCalculator.imageResultHandler]
        }
    }

    /**
     * Call this to stop rendering, aka. clear the previously requested frame
     */
    stopRender() {
        this.isRunning = false
        if (this.renderId) {
            window.cancelAnimationFrame(this.renderId)
            this.renderId = null
        }
    }

    /**
     * Update the face mesh state (in the three.js scene) in this class, which is used in the render loop.
     * @param results Mediapipe holistic results data type, containing hands, body and face coordinates.
     */
    updateScene = (results: Results) => {
        this.latestLandmarks = this.transform(results)
        this.updateSceneUsingLocalFaceState()
        this.updateSceneUsingRemoteFacesState()
        this.renderer.render(this.scene, this.camera);

        if (this.renderId) window.cancelAnimationFrame(this.renderId)
        if (this.isRunning) {
            this.renderId = window.requestAnimationFrame(async () => {
                this.stats.end()
                await this.step()
            })
        }
    };

    // TODO add guide to use arrow keys or WASD
    /**
     * @returns Float32Array All face landmarks for 1 face in a 1-dimensional list: x1, y1, z1, x2, y2, z2.
     * @private
     */
    private normalizedLandmarks1D: Float32Array;

    private transform(results: Results): Float32Array {
        const poseLandmarks = results.poseLandmarks
        const normalizedLandmarks = results.faceLandmarks
        if (normalizedLandmarks) {
            if (!this.normalizedLandmarks1D) {
                this.normalizedLandmarks1D = new Float32Array(normalizedLandmarks.length * 3 + 6);
            }
            // Convert allCoordinates into 1-d array.
            for (let i = 0; i < normalizedLandmarks.length * 3; i++) {
                const meshCoordinateNumber = Math.floor(i / 3)
                const xYZIndex = i % 3
                if (xYZIndex === 0) {
                    this.normalizedLandmarks1D[i] = (normalizedLandmarks[meshCoordinateNumber].x) * this.cameraWidth + this.offset.right
                } else if (xYZIndex === 1) {
                    this.normalizedLandmarks1D[i] = -(normalizedLandmarks[meshCoordinateNumber].y) * this.cameraHeight + (this.cameraHeight) + this.offset.up
                } else {
                    this.normalizedLandmarks1D[i] = (normalizedLandmarks[meshCoordinateNumber].z) * this.cameraWidth
                }
            }

            // 2 shoulders
            this.normalizedLandmarks1D[this.normalizedLandmarks1D.length - 6] = poseLandmarks[12].x * this.cameraWidth + this.offset.right
            this.normalizedLandmarks1D[this.normalizedLandmarks1D.length - 5] = -poseLandmarks[12].y * this.cameraHeight + (this.cameraHeight) + this.offset.up
            this.normalizedLandmarks1D[this.normalizedLandmarks1D.length - 4] = poseLandmarks[12].z
            this.normalizedLandmarks1D[this.normalizedLandmarks1D.length - 3] = poseLandmarks[11].x * this.cameraWidth + this.offset.right
            this.normalizedLandmarks1D[this.normalizedLandmarks1D.length - 2] = -poseLandmarks[11].y * this.cameraHeight + (this.cameraHeight) + this.offset.up
            this.normalizedLandmarks1D[this.normalizedLandmarks1D.length - 1] = poseLandmarks[11].z
        } else {
            console.warn("Face not found...")
        }
        return this.normalizedLandmarks1D
    }

    /**
     * Controls for moving users face on 2D environment
     */
    private MOVE_QUANTITY = 10
    private offset = {
        up: 100,
        right: 50,
    }
    // TODO handle physical edge cases
    moveFace = (direction: Direction) => {
        switch (direction) {
            case Direction.Left:
                this.offset.right -= this.MOVE_QUANTITY
                break
            case Direction.Down:
                this.offset.up -= this.MOVE_QUANTITY
                break
            case Direction.Right:
                this.offset.right += this.MOVE_QUANTITY
                break
            case Direction.Up:
                this.offset.up += this.MOVE_QUANTITY
                break
        }
    }

    private updateSceneUsingLocalFaceState() {
        if (!this.latestLandmarks) {
            return
        }
        if (!this.meshPoints) {
            let material = new PointsMaterial({color: this.faceMeshColor, size: 1.5});
            const geometry = new BufferGeometry()
            this.meshPoints = new Points(geometry, material)
            this.meshPoints.name = "User face mesh"
            this.meshPoints.geometry.setAttribute('position', new BufferAttribute(this.latestLandmarks, 3))
            this.scene.add(this.meshPoints)
        } else {
            if (this.localFaceTrackingEnabled) {
                this.meshPoints.geometry.setAttribute('position', new BufferAttribute(this.latestLandmarks, 3))
                this.meshPoints.geometry.attributes["position"].needsUpdate = true;
            }
        }
    }

    changeLocalFaceMeshColor = (color: string) => {
        this.faceMeshColor = color
        this.meshPoints.material.color = new Color(color)
        this.meshPoints.material.needsUpdate = true
    }

    updateRemoteUserMedia = (remoteUserMedia: UserMedia) => {
        this.remoteUserMedias.set(remoteUserMedia.clientId, remoteUserMedia)
    }

    removeRemoteUser = (clientId: string) => {
        this.remoteUserMedias.delete(clientId)
        const points = this.remoteUserMeshPoints.get(clientId)
        points.parent.remove(points)
        this.remoteUserMeshPoints.delete(clientId)
    }

    private remoteUserMedias = new Map<string, UserMedia>()
    private remoteUserMeshPoints = new Map<string, Points>()

    private updateSceneUsingRemoteFacesState() {
        this.remoteUserMedias.forEach((userMedia: UserMedia, clientId: string) => {
            if (this.remoteUserMeshPoints.has(clientId)) {
                const remoteUserMeshPoints = this.remoteUserMeshPoints.get(clientId)
                remoteUserMeshPoints.geometry.setAttribute('position', new BufferAttribute(userMedia.normalizedLandmarks1D, 3))
                remoteUserMeshPoints.geometry.attributes["position"].needsUpdate = true;
            } else {
                const meshColor = this.remoteUserMedias.get(clientId).faceMeshColor
                let material = new PointsMaterial({color: meshColor, size: 1.5});
                const geometry = new BufferGeometry()
                geometry.setAttribute('position', new BufferAttribute(userMedia.normalizedLandmarks1D, 3))
                const remoteUserMeshPoints = new Points(geometry, material)
                remoteUserMeshPoints.name = `${userMedia.clientId} face mesh`
                this.remoteUserMeshPoints.set(userMedia.clientId, remoteUserMeshPoints)
                this.scene.add(remoteUserMeshPoints)
            }
        }, this)
    }

    /**
     * Face tracking can be paused and re-enabled using this.
     * @param enabled
     */
    async setLocalFaceTrackingTracking(enabled: boolean) {
        this.localFaceTrackingEnabled = enabled
        if (enabled) {
            this.scheduleFaceDataPublishing()
        } else {
            this.cancelFaceDataPublishing()
        }
    }

    private localFaceTrackingEnabled: boolean = true

    dispose() {
        this.renderer.dispose()
        this.stopRender()
        this.holisticCalculator?.close()
    }

    /**
     * Put all your controls in here to keep them tidy.
     *
     * We keep track of keys that are pressed down in a state (this.keysPressed),
     * so that we know when multiple keys are pressed at the same time and can support holding
     * e.g. A + W to go up-and-to-the-left/ north-west.
     */
    private setupKeyControls() {

        document.addEventListener('keyup', (event) => {
            delete this.keysPressed[event.key];
        });

        document.addEventListener('keydown', (event) => {
            this.keysPressed[event.key] = true;

            if (this.keysPressed["ArrowLeft"] || this.keysPressed["a"]) {
                this.moveFace(Direction.Left)
            }

            if (this.keysPressed["ArrowDown"] || this.keysPressed["s"]) {
                this.moveFace(Direction.Down)
            }

            if (this.keysPressed["ArrowRight"] || this.keysPressed["d"]) {
                this.moveFace(Direction.Right)
            }

            if (this.keysPressed["ArrowUp"] || this.keysPressed["w"]) {
                this.moveFace(Direction.Up)
            }
        });
    }

    /**
     * Setting up key controls for the user, such as moving the character
     * @private
     */
    private keysPressed = {};
}
