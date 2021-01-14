/**
 * Copyright (c) 2019-2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 * @author Áron Samuel Kovács <aron.kovacs@mail.muni.cz>
 */

import { WebGLContext } from '../../mol-gl/webgl/context';
import { createNullRenderTarget, RenderTarget } from '../../mol-gl/webgl/render-target';
import Renderer from '../../mol-gl/renderer';
import Scene from '../../mol-gl/scene';
import { Texture } from '../../mol-gl/webgl/texture';
import { Camera, ICamera } from '../camera';
import { QuadSchema, QuadValues } from '../../mol-gl/compute/util';
import { DefineSpec, TextureSpec, UniformSpec, Values } from '../../mol-gl/renderable/schema';
import { ComputeRenderable, createComputeRenderable } from '../../mol-gl/renderable';
import { ShaderCode } from '../../mol-gl/shader-code';
import { createComputeRenderItem } from '../../mol-gl/webgl/render-item';
import { ValueCell } from '../../mol-util';
import { Vec2 } from '../../mol-math/linear-algebra';
import { Helper } from '../helper/helper';

import quad_vert from '../../mol-gl/shader/quad.vert';
import depthMerge_frag from '../../mol-gl/shader/depth-merge.frag';
import { StereoCamera } from '../camera/stereo';
import { WboitPass } from './wboit';

const DepthMergeSchema = {
    ...QuadSchema,
    tDepthPrimitives: TextureSpec('texture', 'depth', 'ushort', 'nearest'),
    tDepthVolumes: TextureSpec('texture', 'depth', 'ushort', 'nearest'),
    uTexSize: UniformSpec('v2'),
    dPackedDepth: DefineSpec('boolean'),
};
const DepthMergeShaderCode = ShaderCode('depth-merge', quad_vert, depthMerge_frag);
type DepthMergeRenderable = ComputeRenderable<Values<typeof DepthMergeSchema>>

function getDepthMergeRenderable(ctx: WebGLContext, depthTexturePrimitives: Texture, depthTextureVolumes: Texture, packedDepth: boolean): DepthMergeRenderable {
    const values: Values<typeof DepthMergeSchema> = {
        ...QuadValues,
        tDepthPrimitives: ValueCell.create(depthTexturePrimitives),
        tDepthVolumes: ValueCell.create(depthTextureVolumes),
        uTexSize: ValueCell.create(Vec2.create(depthTexturePrimitives.getWidth(), depthTexturePrimitives.getHeight())),
        dPackedDepth: ValueCell.create(packedDepth),
    };

    const schema = { ...DepthMergeSchema };
    const renderItem = createComputeRenderItem(ctx, 'triangles', DepthMergeShaderCode, schema, values);

    return createComputeRenderable(renderItem, values);
}

export class DrawPass {
    private readonly drawTarget: RenderTarget

    readonly colorTarget: RenderTarget
    readonly depthTexture: Texture
    readonly depthTexturePrimitives: Texture

    private readonly packedDepth: boolean
    private depthTarget: RenderTarget
    private depthTargetPrimitives: RenderTarget | null
    private depthTargetVolumes: RenderTarget | null
    private depthTextureVolumes: Texture
    private depthMerge: DepthMergeRenderable

    private wboit: WboitPass | undefined

    get wboitEnabled() {
        return !!this.wboit?.enabled;
    }

    constructor(private webgl: WebGLContext, width: number, height: number, enableWboit: boolean) {
        const { extensions, resources } = webgl;

        this.drawTarget = createNullRenderTarget(webgl.gl);

        this.colorTarget = webgl.createRenderTarget(width, height, true, 'uint8', 'linear');
        this.packedDepth = !extensions.depthTexture;

        this.depthTarget = webgl.createRenderTarget(width, height);
        this.depthTexture = this.depthTarget.texture;

        this.depthTargetPrimitives = this.packedDepth ? webgl.createRenderTarget(width, height) : null;
        this.depthTargetVolumes = this.packedDepth ? webgl.createRenderTarget(width, height) : null;

        this.depthTexturePrimitives = this.depthTargetPrimitives ? this.depthTargetPrimitives.texture : resources.texture('image-depth', 'depth', 'ushort', 'nearest');
        this.depthTextureVolumes = this.depthTargetVolumes ? this.depthTargetVolumes.texture : resources.texture('image-depth', 'depth', 'ushort', 'nearest');
        if (!this.packedDepth) {
            this.depthTexturePrimitives.define(width, height);
            this.depthTextureVolumes.define(width, height);
        }
        this.depthMerge = getDepthMergeRenderable(webgl, this.depthTexturePrimitives, this.depthTextureVolumes, this.packedDepth);

        this.wboit = enableWboit ? new WboitPass(webgl, width, height) : undefined;
    }

    setSize(width: number, height: number) {
        const w = this.colorTarget.getWidth();
        const h = this.colorTarget.getHeight();

        if (width !== w || height !== h) {
            this.colorTarget.setSize(width, height);
            this.depthTarget.setSize(width, height);

            if (this.depthTargetPrimitives) {
                this.depthTargetPrimitives.setSize(width, height);
            } else {
                this.depthTexturePrimitives.define(width, height);
            }

            if (this.depthTargetVolumes) {
                this.depthTargetVolumes.setSize(width, height);
            } else {
                this.depthTextureVolumes.define(width, height);
            }

            ValueCell.update(this.depthMerge.values.uTexSize, Vec2.set(this.depthMerge.values.uTexSize.ref.value, width, height));

            if (this.wboit?.enabled) {
                this.wboit.setSize(width, height);
            }
        }
    }

    private _depthMerge(renderer: Renderer, camera: ICamera) {
        const { state, gl } = this.webgl;

        this.depthMerge.update();
        this.depthTarget.bind();

        // #safari-wboit: 4
        // const { x, y, width, height } = camera.viewport;
        // renderer.setViewport(x, y, width, height);

        state.disable(gl.BLEND);
        state.disable(gl.DEPTH_TEST);
        state.disable(gl.CULL_FACE);
        state.depthMask(false);
        state.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.depthMerge.render();
    }

    private _renderWboit(renderer: Renderer, camera: ICamera, scene: Scene, toDrawingBuffer: boolean) {
        if (!this.wboit?.enabled) throw new Error('expected wboit to be enabled');

        // #safari-wboit: 0
        // renderer.setDrawingBufferSize(this.colorTarget.getWidth(), this.colorTarget.getHeight());

        // #safari-wboit
        // const { x, y, width, height } = camera.viewport;

        const renderTarget = toDrawingBuffer ? this.drawTarget : this.colorTarget;
        renderTarget.bind();
        // #safari-wboit: 1
        // renderer.setViewport(x, y, width, height);
        // gl.scissor(x, y, width, height);
        renderer.clear(true);

        // render opaque primitives
        this.depthTexturePrimitives.attachFramebuffer(renderTarget.framebuffer, 'depth');
        renderTarget.bind();
        // #safari-wboit: 2
        // renderer.setViewport(x, y, width, height);
        // gl.scissor(x, y, width, height);
        renderer.renderWboitOpaque(scene.primitives, camera, null);

        // render opaque volumes
        this.depthTextureVolumes.attachFramebuffer(renderTarget.framebuffer, 'depth');
        renderTarget.bind();
        // #safari-wboit: 3
        // renderer.setViewport(x, y, width, height);
        // gl.scissor(x, y, width, height);
        renderer.clearDepth();
        renderer.renderWboitOpaque(scene.volumes, camera, this.depthTexturePrimitives);

        // merge depth of opaque primitives and volumes
        this._depthMerge(renderer, camera);

        // render transparent primitives and volumes
        this.wboit.bind();
        // #safari-wboit: 5
        // renderer.setViewport(x, y, width, height);
        // gl.scissor(x, y, width, height);
        renderer.renderWboitTransparent(scene.primitives, camera, this.depthTexture);
        renderer.renderWboitTransparent(scene.volumes, camera, this.depthTexture);

        // evaluate wboit
        this.depthTexturePrimitives.attachFramebuffer(renderTarget.framebuffer, 'depth');
        renderTarget.bind();
        // #safari-wboit: 6
        // renderer.setViewport(x, y, width, height);
        // gl.scissor(x, y, width, height);
        this.wboit.render(camera.viewport);
    }

    private _renderBlended(renderer: Renderer, camera: ICamera, scene: Scene, toDrawingBuffer: boolean) {
        if (toDrawingBuffer) {
            this.webgl.unbindFramebuffer();
        } else {
            this.colorTarget.bind();
            if (!this.packedDepth) {
                this.depthTexturePrimitives.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
            }
        }

        renderer.clear(true);
        renderer.renderBlendedOpaque(scene.primitives, camera, null);

        // do a depth pass if not rendering to drawing buffer and
        // extensions.depthTexture is unsupported (i.e. depthTarget is set)
        if (!toDrawingBuffer && this.depthTargetPrimitives) {
            this.depthTargetPrimitives.bind();
            renderer.clear(false);
            renderer.renderDepth(scene.primitives, camera, null);
            this.colorTarget.bind();
        }

        // do direct-volume rendering
        if (!toDrawingBuffer) {
            if (!this.packedDepth) {
                this.depthTextureVolumes.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
                renderer.clearDepth(); // from previous frame
            }
            renderer.renderBlendedVolume(scene.volumes, camera, this.depthTexturePrimitives);

            // do volume depth pass if extensions.depthTexture is unsupported (i.e. depthTarget is set)
            if (this.depthTargetVolumes) {
                this.depthTargetVolumes.bind();
                renderer.clear(false);
                renderer.renderDepth(scene.volumes, camera, this.depthTexturePrimitives);
                this.colorTarget.bind();
            }

            if (!this.packedDepth) {
                this.depthTexturePrimitives.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
            }
        }

        renderer.renderBlendedTransparent(scene.primitives, camera, null);

        // merge depths from primitive and volume rendering
        if (!toDrawingBuffer) {
            this._depthMerge(renderer, camera);
            this.colorTarget.bind();
        }
    }

    private _render(renderer: Renderer, camera: ICamera, scene: Scene, helper: Helper, toDrawingBuffer: boolean) {
        const { x, y, width, height } = camera.viewport;
        renderer.setViewport(x, y, width, height);
        renderer.update(camera);

        if (this.wboitEnabled) {
            this._renderWboit(renderer, camera, scene, toDrawingBuffer);
        } else {
            this._renderBlended(renderer, camera, scene, toDrawingBuffer);
        }

        if (helper.debug.isEnabled) {
            helper.debug.syncVisibility();
            renderer.renderBlended(helper.debug.scene, camera, null);
        }
        if (helper.handle.isEnabled) {
            renderer.renderBlended(helper.handle.scene, camera, null);
        }
        if (helper.camera.isEnabled) {
            helper.camera.update(camera);
            renderer.update(helper.camera.camera);
            renderer.renderBlended(helper.camera.scene, helper.camera.camera, null);
        }

        this.webgl.gl.flush();
    }

    render(renderer: Renderer, camera: Camera | StereoCamera, scene: Scene, helper: Helper, toDrawingBuffer: boolean, transparentBackground: boolean) {
        renderer.setTransparentBackground(transparentBackground);
        renderer.setDrawingBufferSize(this.colorTarget.getWidth(), this.colorTarget.getHeight());

        if (StereoCamera.is(camera)) {
            this._render(renderer, camera.left, scene, helper, toDrawingBuffer);
            this._render(renderer, camera.right, scene, helper, toDrawingBuffer);
        } else {
            this._render(renderer, camera, scene, helper, toDrawingBuffer);
        }
    }
}