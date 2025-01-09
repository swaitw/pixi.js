import EventEmitter from 'eventemitter3';
import { Bounds } from '../../../../scene/container/bounds/Bounds';
import { uid } from '../../../../utils/data/uid';
import { Buffer } from '../buffer/Buffer';
import { ensureIsBuffer } from './utils/ensureIsBuffer';
import { getGeometryBounds } from './utils/getGeometryBounds';

import type { TypedArray } from '../buffer/Buffer';
import type { Topology, VertexFormat } from './const';

export type IndexBufferArray = Uint16Array | Uint32Array;

/**
 * The attribute data for a geometries attributes
 * @memberof rendering
 */
export interface Attribute
{
    /** the buffer that this attributes data belongs to */
    buffer: Buffer;
    /** the format of the attribute */
    format?: VertexFormat;
    /** the stride of the data in the buffer - in bytes*/
    stride?: number;
    /** the offset of the attribute from the buffer, defaults to 0 - in bytes*/
    offset?: number;
    /** is this an instanced buffer? (defaults to false) */
    instance?: boolean;
    /** the number of elements to be rendered. If not specified, all vertices after the starting vertex will be drawn. */
    size?: number;
    /**
     * the starting vertex in the geometry to start drawing from. If not specified,
     *  drawing will start from the first vertex.
     */
    start?: number;
    /**
     * attribute divisor for instanced rendering. Note: this is a **WebGL-only** feature, the WebGPU renderer will
     * issue a warning if one of the attributes has divisor set.
     */
    divisor?: number;
}

/**
 * The attribute options used by the constructor for adding geometries attributes
 * extends {@link rendering.Attribute} but allows for the buffer to be a typed or number array
 * @memberof rendering
 */
type AttributeOption = Omit<Attribute, 'buffer'> & { buffer: Buffer | TypedArray | number[]}
| Buffer | TypedArray | number[];

export type AttributeOptions = Record<string, AttributeOption>;

/**
 * the interface that describes the structure of the geometry
 * @memberof rendering
 */
export interface GeometryDescriptor
{
    /** an optional label to easily identify the geometry */
    label?: string;
    /** the attributes that make up the geometry */
    attributes?: AttributeOptions;
    /** optional index buffer for this geometry */
    indexBuffer?: Buffer | TypedArray | number[];
    /** the topology of the geometry, defaults to 'triangle-list' */
    topology?: Topology;

    instanceCount?: number;
}
function ensureIsAttribute(attribute: AttributeOption): Attribute
{
    if (attribute instanceof Buffer || Array.isArray(attribute) || (attribute as TypedArray).BYTES_PER_ELEMENT)
    {
        attribute = {
            buffer: attribute as Buffer | TypedArray | number[],
        };
    }

    (attribute as Attribute).buffer = ensureIsBuffer(attribute.buffer as Buffer | TypedArray | number[], false);

    return attribute as Attribute;
}

/**
 * A Geometry is a low-level object that represents the structure of 2D shapes in terms of vertices and attributes.
 * It's a crucial component for rendering as it describes the shape and format of the data that will go through the shaders.
 * Essentially, a Geometry object holds the data you'd send to a GPU buffer.
 *
 * A geometry is basically made of two components:
 * <br>
 * <b>Attributes</b>: These are essentially arrays that define properties of the vertices like position, color,
 * texture coordinates, etc. They map directly to attributes in your vertex shaders.
 * <br>
 * <b>Indices</b>: An optional array that describes how the vertices are connected.
 * If not provided, vertices will be interpreted in the sequence they're given.
 * @example
 *
 * const geometry = new Geometry({
 *   attributes: {
 *     aPosition: [ // add some positions
 *       0, 0,
 *       0, 100,
 *       100, 100,
 *       100,   0,
 *     ],
 *     aUv: [ // add some uvs
 *       0, 0,
 *       0, 1,
 *       1, 1,
 *       1, 0,
 *     ]
 *   }
 * });
 * @memberof rendering
 * @class
 */
export class Geometry extends EventEmitter<{
    update: Geometry,
    destroy: Geometry,
}>
{
    /** The topology of the geometry. */
    public topology: Topology;
    /** The unique id of the geometry. */
    public readonly uid: number = uid('geometry');
    /** A record of the attributes of the geometry. */
    public readonly attributes: Record<string, Attribute>;
    /** The buffers that the attributes use */
    public readonly buffers: Buffer[];
    /** The index buffer of the geometry */
    public indexBuffer: Buffer;

    /**
     * the layout key will be generated by WebGPU all geometries that have the same structure
     * will have the same layout key. This is used to cache the pipeline layout
     * @internal
     * @ignore
     */
    public _layoutKey = 0;

    /** the instance count of the geometry to draw */
    public instanceCount = 1;

    private readonly _bounds: Bounds = new Bounds();
    private _boundsDirty = true;

    /**
     * Create a new instance of a geometry
     * @param options - The options for the geometry.
     */
    constructor(options: GeometryDescriptor = {})
    {
        super();

        const { attributes, indexBuffer, topology } = options;

        this.buffers = [];

        this.attributes = {};

        if (attributes)
        {
            for (const i in attributes)
            {
                this.addAttribute(i, attributes[i]);
            }
        }

        this.instanceCount = options.instanceCount ?? 1;

        if (indexBuffer)
        {
            this.addIndex(indexBuffer);
        }

        this.topology = topology || 'triangle-list';
    }

    protected onBufferUpdate(): void
    {
        this._boundsDirty = true;
        this.emit('update', this);
    }

    /**
     * Returns the requested attribute.
     * @param id - The name of the attribute required
     * @returns - The attribute requested.
     */
    public getAttribute(id: string): Attribute
    {
        return this.attributes[id];
    }

    /**
     * Returns the index buffer
     * @returns - The index buffer.
     */
    public getIndex(): Buffer
    {
        return this.indexBuffer;
    }

    /**
     * Returns the requested buffer.
     * @param id - The name of the buffer required.
     * @returns - The buffer requested.
     */
    public getBuffer(id: string): Buffer
    {
        return this.getAttribute(id).buffer;
    }

    /**
     * Used to figure out how many vertices there are in this geometry
     * @returns the number of vertices in the geometry
     */
    public getSize(): number
    {
        for (const i in this.attributes)
        {
            const attribute = this.attributes[i];
            const buffer = attribute.buffer;

            // TODO use SIZE again like v7..
            return (buffer.data as any).length / ((attribute.stride / 4) || attribute.size);
        }

        return 0;
    }

    /**
     * Adds an attribute to the geometry.
     * @param name - The name of the attribute to add.
     * @param attributeOption - The attribute option to add.
     */
    public addAttribute(name: string, attributeOption: AttributeOption): void
    {
        const attribute = ensureIsAttribute(attributeOption);

        const bufferIndex = this.buffers.indexOf(attribute.buffer);

        if (bufferIndex === -1)
        {
            this.buffers.push(attribute.buffer);

            // two events here - one for a resize (new buffer change)
            // and one for an update (existing buffer change)
            attribute.buffer.on('update', this.onBufferUpdate, this);
            attribute.buffer.on('change', this.onBufferUpdate, this);
        }
        this.attributes[name] = attribute;
    }

    /**
     * Adds an index buffer to the geometry.
     * @param indexBuffer - The index buffer to add. Can be a Buffer, TypedArray, or an array of numbers.
     */
    public addIndex(indexBuffer: Buffer | TypedArray | number[]): void
    {
        this.indexBuffer = ensureIsBuffer(indexBuffer, true);
        this.buffers.push(this.indexBuffer);
    }

    /** Returns the bounds of the geometry. */
    get bounds(): Bounds
    {
        if (!this._boundsDirty) return this._bounds;

        this._boundsDirty = false;

        return getGeometryBounds(this, 'aPosition', this._bounds);
    }

    /**
     * destroys the geometry.
     * @param destroyBuffers - destroy the buffers associated with this geometry
     */
    public destroy(destroyBuffers = false): void
    {
        this.emit('destroy', this);

        this.removeAllListeners();

        if (destroyBuffers)
        {
            this.buffers.forEach((buffer) => buffer.destroy());
        }

        (this.attributes as null) = null;
        (this.buffers as null) = null;
        (this.indexBuffer as null) = null;
        (this._bounds as null) = null;
    }
}
