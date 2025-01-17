import { Dict, isNullable, valueMap } from 'cosmokit'
import { Eval, isComparable, Query, Selection } from 'minato'
import { Filter, FilterOperators } from 'mongodb'
import MongoDriver from '.'

function createFieldFilter(query: Query.FieldQuery, key: string) {
  const filters: Filter<any>[] = []
  const result: Filter<any> = {}
  const child = transformFieldQuery(query, key, filters)
  if (child === false) return false
  if (child !== true) result[key] = child
  if (filters.length) result.$and = filters
  if (Object.keys(result).length) return result
  return true
}

function transformFieldQuery(query: Query.FieldQuery, key: string, filters: Filter<any>[]) {
  // shorthand syntax
  if (isComparable(query)) {
    return { $eq: query }
  } else if (Array.isArray(query)) {
    if (!query.length) return false
    return { $in: query }
  } else if (query instanceof RegExp) {
    return { $regex: query }
  } else if (isNullable(query)) {
    return { $exists: false }
  }

  // query operators
  const result: FilterOperators<any> = {}
  for (const prop in query) {
    if (prop === '$and') {
      for (const item of query[prop]) {
        const child = createFieldFilter(item, key)
        if (child === false) return false
        if (child !== true) filters.push(child)
      }
    } else if (prop === '$or') {
      const $or: Filter<any>[] = []
      if (!query[prop].length) return false
      const always = query[prop].some((item) => {
        const child = createFieldFilter(item, key)
        if (typeof child === 'boolean') return child
        $or.push(child)
      })
      if (!always) filters.push({ $or })
    } else if (prop === '$not') {
      const child = createFieldFilter(query[prop], key)
      if (child === true) return false
      if (child !== false) filters.push({ $nor: [child] })
    } else if (prop === '$el') {
      const child = transformFieldQuery(query[prop], key, filters)
      if (child === false) return false
      if (child !== true) result.$elemMatch = child
    } else if (prop === '$regexFor') {
      filters.push({
        $expr: {
          $regexMatch: {
            input: query[prop],
            regex: '$' + key,
          },
        },
      })
    } else {
      result[prop] = query[prop]
    }
  }
  if (!Object.keys(result).length) return true
  return result
}

export type ExtractUnary<T> = T extends [infer U] ? U : T

export type EvalOperators = {
  [K in keyof Eval.Static as `$${K}`]?: (expr: ExtractUnary<Parameters<Eval.Static[K]>>, group?: object) => any
} & { $: (expr: any, group?: object) => any }

const aggrKeys = ['$sum', '$avg', '$min', '$max', '$count', '$length', '$array']

export class Transformer {
  private counter = 0
  public table!: string
  public walkedKeys: string[] = []
  public pipeline: any[] = []
  protected lookups: any[] = []
  public evalKey?: string
  private refTables: string[] = []
  private refVirtualKeys: Dict<string> = {}
  public aggrDefault: any

  private evalOperators: EvalOperators

  constructor(private tables: string[], public virtualKey?: string, public recursivePrefix: string = '$') {
    this.walkedKeys = []

    this.evalOperators = {
      $: (arg, group) => {
        if (typeof arg === 'string') {
          this.walkedKeys.push(this.getActualKey(arg))
          return this.recursivePrefix + this.getActualKey(arg)
        } else if (this.tables.includes(arg[0])) {
          this.walkedKeys.push(this.getActualKey(arg[1]))
          return this.recursivePrefix + this.getActualKey(arg[1])
        } else if (this.refTables.includes(arg[0])) {
          return `$$${arg[0]}.` + this.getActualKey(arg[1], arg[0])
        } else {
          throw new Error(`$ not transformed: ${JSON.stringify(arg)}`)
        }
      },
      $if: (arg, group) => ({ $cond: arg.map(val => this.eval(val, group)) }),
      $array: (arg, group) => this.transformEvalExpr(arg),
      $object: (arg, group) => this.transformEvalExpr(arg),

      $regex: (arg, group) => ({ $regexMatch: { input: this.eval(arg[0], group), regex: this.eval(arg[1], group) } }),

      $length: (arg, group) => ({ $size: this.eval(arg, group) }),
      $nin: (arg, group) => ({ $not: { $in: arg.map(val => this.eval(val, group)) } }),

      $modulo: (arg, group) => ({ $mod: arg.map(val => this.eval(val, group)) }),
      $log: ([left, right], group) => isNullable(right)
        ? { $ln: this.eval(left, group) }
        : { $log: [this.eval(left, group), this.eval(right, group)] },
      $power: (arg, group) => ({ $pow: arg.map(val => this.eval(val, group)) }),
      $random: (arg, group) => ({ $rand: {} }),

      $number: (arg, group) => {
        const value = this.eval(arg, group)
        return {
          $ifNull: [{
            $switch: {
              branches: [
                {
                  case: { $eq: [{ $type: value }, 'date'] },
                  then: { $floor: { $divide: [{ $toLong: value }, 1000] } },
                },
              ],
              default: { $toDouble: value },
            },
          }, 0],
        }
      },

      $exec: (arg, group) => {
        const sel = arg as Selection
        const transformer = this.createSubquery(sel)
        if (!transformer) throw new Error(`Selection cannot be executed: ${JSON.stringify(arg)}`)

        const name = this.createKey()
        this.lookups.push({
          $lookup: {
            from: transformer.table,
            as: name,
            let: {
              [this.tables[0]]: '$$ROOT',
            },
            pipeline: transformer.pipeline,
          },
        }, {
          $set: {
            [name]: !(sel.args[0] as any).$ ? {
              $getField: {
                input: {
                  $ifNull: [
                    { $arrayElemAt: ['$' + name, 0] },
                    { [transformer.evalKey!]: transformer.aggrDefault },
                  ],
                },
                field: transformer.evalKey!,
              },
            } : {
              $map: {
                input: '$' + name,
                as: 'el',
                in: '$$el.' + transformer.evalKey!,
              },
            },
          },
        })
        return `$${name}`
      },
    }
  }

  public createKey() {
    return '_temp_' + ++this.counter
  }

  protected getActualKey(key: string, ref?: string) {
    return key === (ref ? this.refVirtualKeys[ref] : this.virtualKey) ? '_id' : key
  }

  private transformEvalExpr(expr: any, group?: Dict) {
    // https://jira.mongodb.org/browse/SERVER-54046
    // mongo supports empty object in $set from 6.1.0/7.0.0
    if (Object.keys(expr).length === 0) {
      return { $literal: expr }
    }

    for (const key in expr) {
      if (this.evalOperators[key]) {
        return this.evalOperators[key](expr[key], group)
      }
    }

    if (Array.isArray(expr)) {
      return expr.map(val => this.eval(val, group))
    }

    return valueMap(expr as any, (value) => {
      if (Array.isArray(value)) {
        return value.map(val => this.eval(val, group))
      } else {
        return this.eval(value, group)
      }
    })
  }

  private transformAggr(expr: any) {
    if (typeof expr === 'number' || typeof expr === 'boolean' || expr instanceof Date) {
      return expr
    }

    if (typeof expr === 'string') {
      this.walkedKeys.push(expr)
      return this.recursivePrefix + expr
    }

    return this.transformEvalExpr(expr)
  }

  public flushLookups() {
    const ret = this.lookups
    this.lookups = []
    return ret
  }

  public eval(expr: any, group?: Dict) {
    if (isComparable(expr) || isNullable(expr)) {
      return expr
    }

    if (group) {
      for (const type of aggrKeys) {
        if (!expr[type]) continue
        const key = this.createKey()
        const value = this.transformAggr(expr[type])
        this.aggrDefault = 0
        if (type === '$count') {
          group![key] = { $addToSet: value }
          return { $size: '$' + key }
        } else if (type === '$length') {
          group![key] = { $push: value }
          return { $size: '$' + key }
        } else if (type === '$array') {
          this.aggrDefault = []
          group![key] = { $push: value }
          return '$' + key
        } else {
          group![key] = { [type]: value }
          return '$' + key
        }
      }
    }

    return this.transformEvalExpr(expr, group)
  }

  public query(query: Query.Expr) {
    const filter: Filter<any> = {}
    const additional: Filter<any>[] = []
    for (const key in query) {
      const value = query[key]
      if (key === '$and' || key === '$or') {
        // MongoError: $and/$or/$nor must be a nonempty array
        // { $and: [] } matches everything
        // { $or: [] } matches nothing
        if (value.length) {
          filter[key] = value.map(query => this.query(query))
        } else if (key === '$or') {
          return
        }
      } else if (key === '$not') {
        // MongoError: unknown top level operator: $not
        // https://stackoverflow.com/questions/25270396/mongodb-how-to-invert-query-with-not
        // this may solve this problem but lead to performance degradation
        const query = this.query(value)
        if (query) filter.$nor = [query]
      } else if (key === '$expr') {
        additional.push({ $expr: this.eval(value) })
      } else {
        const actualKey = this.getActualKey(key)
        const query = transformFieldQuery(value, actualKey, additional)
        if (query === false) return
        if (query !== true) filter[actualKey] = query
      }
    }
    if (additional.length) {
      (filter.$and ||= []).push(...additional)
    }
    return filter
  }

  modifier(stages: any[], sel: Selection.Immutable) {
    const { args, model } = sel
    const { fields, offset, limit, sort, group, having } = args[0]

    // orderBy, limit, offset
    const $set = {}
    const $sort = {}
    const $unset: string[] = []
    for (const [expr, dir] of sort) {
      const value = this.eval(expr)
      if (typeof value === 'string') {
        $sort[value.slice(1)] = dir === 'desc' ? -1 : 1
      } else {
        const key = this.createKey()
        $set[key] = value
        $sort[key] = dir === 'desc' ? -1 : 1
        $unset.push(key)
      }
    }
    if ($unset.length) stages.push({ $set })
    if (Object.keys($sort).length) stages.push({ $sort })
    if ($unset.length) stages.push({ $unset })
    if (limit < Infinity) {
      stages.push({ $limit: offset + limit })
    }
    if (offset) {
      stages.push({ $skip: offset })
    }

    // groupBy, having, fields
    if (group) {
      const $group: Dict = { _id: {} }
      const $project: Dict = { _id: 0 }
      const groupStages: any[] = [{ $group }]

      for (const key in fields) {
        if (group.includes(key)) {
          $group._id[key] = this.eval(fields[key])
          $project[key] = '$_id.' + key
        } else {
          $project[key] = this.eval(fields[key], $group)
        }
      }
      if (having['$and'].length) {
        const $expr = this.eval(having, $group)
        groupStages.push(...this.flushLookups(), { $match: { $expr } })
      }
      stages.push(...this.flushLookups(), ...groupStages, { $project })
      $group['_id'] = model.parse($group['_id'], false)
    } else if (fields) {
      const $project = valueMap(fields, (expr) => this.eval(expr))
      $project._id = 0
      stages.push(...this.flushLookups(), { $project })
    } else {
      const $project: Dict = { _id: 0 }
      for (const key in model.fields) {
        $project[key] = key === this.virtualKey ? '$_id' : 1
      }
      stages.push({ $project })
    }
  }

  protected createSubquery(sel: Selection.Immutable) {
    const predecessor = new Transformer(Object.keys(sel.tables))
    predecessor.refTables = [...this.refTables, ...this.tables]
    predecessor.refVirtualKeys = this.refVirtualKeys
    return predecessor.select(sel)
  }

  public select(sel: Selection.Immutable) {
    const { table, query } = sel
    if (typeof table === 'string') {
      this.table = table
      this.refVirtualKeys[sel.ref] = this.virtualKey = (sel.driver as MongoDriver).getVirtualKey(table)!
    } else if (table instanceof Selection) {
      const predecessor = this.createSubquery(table)
      if (!predecessor) return
      this.table = predecessor.table
      this.pipeline.push(...predecessor.flushLookups(), ...predecessor.pipeline)
    } else {
      for (const [name, subtable] of Object.entries(table)) {
        const predecessor = this.createSubquery(subtable)
        if (!predecessor) return
        if (!this.table) {
          this.table = predecessor.table
          this.pipeline.push(...predecessor.flushLookups(), ...predecessor.pipeline, {
            $replaceRoot: { newRoot: { [name]: '$$ROOT' } },
          })
          continue
        }
        const $lookup = {
          from: predecessor.table,
          as: name,
          pipeline: predecessor.pipeline,
        }
        const $unwind = {
          path: `$${name}`,
        }
        this.pipeline.push({ $lookup }, { $unwind })
      }
      if (sel.args[0].having['$and'].length) {
        const $expr = this.eval(sel.args[0].having)
        this.pipeline.push(...this.flushLookups(), { $match: { $expr } })
      }
    }

    // where
    const filter = this.query(query)
    if (!filter) return
    if (Object.keys(filter).length) {
      this.pipeline.push(...this.flushLookups(), { $match: filter })
    }

    if (sel.type === 'get') {
      this.modifier(this.pipeline, sel)
    } else if (sel.type === 'eval') {
      const $ = this.createKey()
      const $group: Dict = { _id: null }
      const $project: Dict = { _id: 0 }
      $project[$] = this.eval(sel.args[0], $group)
      if (Object.keys($group).length === 1) {
        this.pipeline.push(...this.flushLookups(), { $project })
      } else {
        this.pipeline.push({ $group }, ...this.flushLookups(), { $project })
      }
      this.evalKey = $
    }
    return this
  }
}
