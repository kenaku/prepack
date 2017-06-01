/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { GlobalEnvironmentRecord, DeclarativeEnvironmentRecord } from "../environment.js";
import { Realm } from "../realm.js";
import type { Descriptor } from "../types.js";
import { IsUnresolvableReference, ResolveBinding, IsArray, Get } from "../methods/index.js";
import { BoundFunctionValue, ProxyValue, SymbolValue, AbstractValue, EmptyValue, FunctionValue, NumberValue, Value, ObjectValue, PrimitiveValue, NativeFunctionValue, UndefinedValue } from "../values/index.js";
import { describeLocation } from "../intrinsics/ecma262/Error.js";
import * as t from "babel-types";
import type { BabelNodeExpression, BabelNodeBlockStatement } from "babel-types";
import { Generator } from "../utils/generator.js";
import traverse from "babel-traverse";
import invariant from "../invariant.js";
import type { VisitedBinding, VisitedBindings, FunctionInfo } from "./types.js";
import { ClosureRefVisitor } from "./visitors.js";
import { Logger } from "./logger.js";
import { Modules } from "./modules.js";

/* This class visits all values that are reachable in the residual heap.
   In particular, this "filters out" values that are...
   - captured by a DeclarativeEnvironmentRecord, but not actually used by any closure.
   - Unmodified prototype objects
   TODO #492: Figure out minimal set of values that need to be kept alive for WeakSet and WeakMap instances.
*/
export class ResidualHeapVisitor {
  constructor(realm: Realm, logger: Logger, modules: Modules, requireReturns: Map<number | string, BabelNodeExpression>) {
    invariant(realm.useAbstractInterpretation);
    this.realm = realm;
    this.logger = logger;
    this.modules = modules;
    this.requireReturns = requireReturns;

    this.declarativeEnvironmentRecordsBindings = new Map();
    this.globalBindings = new Map();
    this.functionInfos = new Map();
    this.functionBindings = new Map();
    this.values = new Set();
    this.ignoredProperties = new Map();
  }

  realm: Realm;
  logger: Logger;
  modules: Modules;
  requireReturns: Map<number | string, BabelNodeExpression>;

  declarativeEnvironmentRecordsBindings: Map<DeclarativeEnvironmentRecord, VisitedBindings>;
  globalBindings: Map<string, VisitedBinding>;
  functionInfos: Map<BabelNodeBlockStatement, FunctionInfo>;
  functionBindings: Map<FunctionValue, VisitedBindings>;
  values: Set<Value>;
  ignoredProperties: Map<ObjectValue, Set<string>>;

  static isLeaf(val: Value): boolean {
    if (val instanceof SymbolValue) {
      return false;
    }

    if (val instanceof AbstractValue && val.hasIdentifier()) {
      return true;
    }

    if (val.isIntrinsic()) {
      return false;
    }

    return val instanceof PrimitiveValue;
  }

  _canIgnoreProperty(val: ObjectValue, key: string, desc: Descriptor) {
    if (IsArray(this.realm, val)) {
      if (key === "length" && desc.writable && !desc.enumerable && !desc.configurable) {
        // length property has the correct descriptor values
        return true;
      }
    } else if (val instanceof FunctionValue) {
      if (key === "length") {
        if (desc.value === undefined) {
          this.logger.logError(val, "Functions with length accessor properties are not supported in residual heap.");
          // Rationale: .bind() would call the accessor, which might throw, mutate state, or do whatever...
        }
        // length property will be inferred already by the amount of parameters
        return !desc.writable && !desc.enumerable && desc.configurable && val.hasDefaultLength();
      }

      if (key === "name") {
        // TODO #474: Make sure that we retain original function names. Or set name property. Or ensure that nothing references the name property.
        return true;
      }

      // Properties `caller` and `arguments` are added to normal functions in non-strict mode to prevent TypeErrors.
      // Because they are autogenerated, they should be ignored.
      if (key === "arguments" || key === "caller") {
        if (!val.$Strict && desc.writable && !desc.enumerable && desc.configurable && desc.value instanceof UndefinedValue && val.$FunctionKind === 'normal')
          return true;
      }

      // ignore the `prototype` property when it's the right one
      if (key === "prototype") {
        if (!desc.configurable && !desc.enumerable && desc.writable &&
            desc.value instanceof ObjectValue && desc.value.originalConstructor === val) {
          return true;
        }
      }
    } else {
      let kind = val.getKind();
      switch (kind) {
        case "RegExp":
          if (key === "lastIndex" && desc.writable && !desc.enumerable && !desc.configurable) {
            // length property has the correct descriptor values
            let v = desc.value;
            return v instanceof NumberValue && v.value === 0;
          }
          break;
        default:
          break;
      }
    }

    if (key === "constructor") {
      if (desc.configurable && !desc.enumerable && desc.writable && desc.value === val.originalConstructor) return true;
    }

    return false;
  }

  visitObjectProperties(obj: ObjectValue): void {
    /*
    for (let symbol of obj.symbols.keys()) {
      // TODO #22: visit symbols
    }
    */

    // visit properties
    for (let [key, propertyBinding] of obj.properties) {
      invariant(propertyBinding);
      let desc = propertyBinding.descriptor;
      if (desc === undefined) continue; //deleted
      if (this._canIgnoreProperty(obj, key, desc)) {
        let set = this.ignoredProperties.get(obj);
        if (!set) this.ignoredProperties.set(obj, set = new Set());
        set.add(key);
        continue;
      }
      this.visitDescriptor(desc);
    }

    // inject properties with computed names
    if (obj.unknownProperty !== undefined) {
      let desc = obj.unknownProperty.descriptor;
      if (desc !== undefined) {
        let val = desc.value;
        invariant(val instanceof AbstractValue);
        this.visitObjectPropertiesWithComputedNames(val);
      }
    }

    // prototype
    this.visitObjectPrototype(obj);
    if (obj instanceof FunctionValue) this.visitConstructorPrototype(obj);
  }

  visitObjectPrototype(obj: ObjectValue) {
    let proto = obj.$Prototype;

    let kind = obj.getKind();
    if (proto === this.realm.intrinsics[kind + "Prototype"]) return;

    this.visitValue(proto);
  }

  visitConstructorPrototype(func: FunctionValue) {
    // If the original prototype object was mutated,
    // request its serialization here as this might be observable by
    // residual code.
    let prototype = ResidualHeapVisitor.getPropertyValue(func, "prototype");
    if (prototype instanceof ObjectValue &&
      prototype.originalConstructor === func &&
      !this.isDefaultPrototype(prototype)) {
      this.visitValue(prototype);
    }
  }

  visitObjectPropertiesWithComputedNames(absVal: AbstractValue): void {
    invariant(absVal.args.length === 3);
    let cond = absVal.args[0];
    invariant(cond instanceof AbstractValue);
    if (cond.kind === "template for property name condition") {
      let P = cond.args[0]; invariant(P instanceof AbstractValue);
      let V = absVal.args[1];
      let earlier_props = absVal.args[2];
      if (earlier_props instanceof AbstractValue)
        this.visitObjectPropertiesWithComputedNames(earlier_props);
      this.visitValue(P);
      this.visitValue(V);
    } else {
      // conditional assignment
      this.visitValue(cond);
      let consequent = absVal.args[1]; invariant(consequent instanceof AbstractValue);
      let alternate = absVal.args[2]; invariant(alternate instanceof AbstractValue);
      this.visitObjectPropertiesWithComputedNames(consequent);
      this.visitObjectPropertiesWithComputedNames(alternate);
    }
  }

  visitDescriptor(desc: Descriptor): void {
    if (desc.value !== undefined) this.visitValue(desc.value);
    if (desc.get !== undefined) this.visitValue(desc.get);
    if (desc.set !== undefined) this.visitValue(desc.set);
  }

  visitDeclarativeEnvironmentRecordBinding(r: DeclarativeEnvironmentRecord, n: string): VisitedBinding {
    let visitedBindings = this.declarativeEnvironmentRecordsBindings.get(r);
    if (!visitedBindings) {
      visitedBindings = Object.create(null);
      this.declarativeEnvironmentRecordsBindings.set(r, visitedBindings);
    }
    let visitedBinding: ?VisitedBinding = visitedBindings[n];
    if (!visitedBinding) {
      let realm = this.realm;
      let binding = r.bindings[n];
      invariant(!binding.deletable);
      let value = (binding.initialized && binding.value) || realm.intrinsics.undefined;
      visitedBinding = { global: false, value, modified: false, declarativeEnvironmentRecord: r };
      visitedBindings[n] = visitedBinding;
      this.visitValue(value);
    }
    return visitedBinding;
  }

  visitValueIntrinsic(val: Value): void {
  }

  visitValueArray(val: ObjectValue): void {
    this.visitObjectProperties(val);
    let lenProperty = Get(this.realm, val, "length");
    if (lenProperty instanceof AbstractValue) this.visitValue(lenProperty);
  }

  visitValueMap(val: ObjectValue): void {
    let kind = val.getKind();

    let entries;
    if (kind === "Map") {
      entries = val.$MapData;
    } else {
      invariant(kind === "WeakMap");
      entries = val.$WeakMapData;
    }
    invariant(entries !== undefined);
    let len = entries.length;

    for (let i = 0; i < len; i++) {
      let entry = entries[i];
      let key = entry.$Key;
      let value = entry.$Value;
      if (key === undefined || value === undefined) continue;
      this.visitValue(key);
      this.visitValue(value);
    }
  }

  visitValueSet(val: ObjectValue): void {
    let kind = val.getKind();

    let entries;
    if (kind === "Set") {
      entries = val.$SetData;
    } else {
      invariant(kind === "WeakSet");
      entries = val.$WeakSetData;
    }
    invariant(entries !== undefined);
    let len = entries.length;

    for (let i = 0; i < len; i++) {
      let entry = entries[i];
      if (entry === undefined) continue;
      this.visitValue(entry);
    }
  }

  static getPropertyValue(val: ObjectValue, name: string): void | Value {
    let prototypeBinding = val.properties.get(name);
    if (prototypeBinding === undefined) return undefined;
    let prototypeDesc = prototypeBinding.descriptor;
    if (prototypeDesc === undefined) return undefined;
    return prototypeDesc.value;
  }

  isDefaultPrototype(prototype: ObjectValue): boolean {
    if (prototype.symbols.size !== 0 ||
      prototype.$Prototype !== this.realm.intrinsics.ObjectPrototype ||
      !prototype.getExtensible()) return false;
    let foundConstructor = false;
    for (let name of prototype.properties.keys())
      if (name === "constructor" &&
        ResidualHeapVisitor.getPropertyValue(prototype, name) === prototype.originalConstructor)
        foundConstructor = true;
      else
        return false;
    return foundConstructor;
  }

  visitValueFunction(val: FunctionValue): void {
    this.visitObjectProperties(val);

    if (val instanceof BoundFunctionValue) {
      this.visitValue(val.$BoundTargetFunction);
      this.visitValue(val.$BoundThis);
      for (let boundArg of val.$BoundArguments) this.visitValue(boundArg);
      return;
    }

    if (val instanceof NativeFunctionValue) {
      return;
    }

    invariant(val.constructor === FunctionValue);
    let formalParameters = val.$FormalParameters;
    invariant(formalParameters != null);
    let code = val.$ECMAScriptCode;
    invariant(code != null);

    let functionInfo = this.functionInfos.get(code);

    if (!functionInfo) {
      functionInfo = {
        names: Object.create(null),
        modified: Object.create(null),
        usesArguments: false,
        usesThis: false,
      };
      this.functionInfos.set(code, functionInfo);

      let state = {
        tryQuery: this.logger.tryQuery.bind(this.logger),
        val,
        functionInfo,
        map: functionInfo.names,
        realm: this.realm };

      traverse(
        t.file(t.program([
          t.expressionStatement(
            t.functionExpression(
              null,
              formalParameters,
              code
            )
          )
        ])),
        ClosureRefVisitor,
        null,
        state
      );

      if (val.isResidual && Object.keys(functionInfo.names).length) {
        this.logger.logError(val, `residual function ${describeLocation(this.realm, val, undefined, code.loc) || "(unknown)"} refers to the following identifiers defined outside of the local scope: ${Object.keys(functionInfo.names).join(", ")}`);
      }
    }

    let visitedBindings = Object.create(null);
    for (let innerName in functionInfo.names) {
      let visitedBinding;
      let doesNotMatter = true;
      let reference = this.logger.tryQuery(
        () => ResolveBinding(this.realm, innerName, doesNotMatter, val.$Environment),
        undefined, true);
      if (reference === undefined) {
        visitedBinding = this.visitGlobalBinding(innerName);
      } else {
        invariant(!IsUnresolvableReference(this.realm, reference));
        let referencedBase = reference.base;
        let referencedName: string = (reference.referencedName: any);
        if (typeof referencedName !== "string") {
          throw new Error("TODO: do not know how to visit reference with symbol");
        }
        if (reference.base instanceof GlobalEnvironmentRecord) {
          visitedBinding = this.visitGlobalBinding(referencedName);
        } else if (referencedBase instanceof DeclarativeEnvironmentRecord) {
          visitedBinding = this.visitDeclarativeEnvironmentRecordBinding(referencedBase, referencedName);
        } else {
          invariant(false);
        }
      }
      visitedBindings[innerName] = visitedBinding;
      if (functionInfo.modified[innerName]) visitedBinding.modified = true;
    }

    this.functionBindings.set(val, visitedBindings);
  }

  visitValueObject(val: ObjectValue): void {
    this.visitObjectProperties(val);

    // If this object is a prototype object that was implicitly created by the runtime
    // for a constructor, then we can obtain a reference to this object
    // in a special way that's handled alongside function serialization.
    let constructor = val.originalConstructor;
    if (constructor !== undefined) {
      this.visitValue(constructor);
      return;
    }

    let kind = val.getKind();
    switch (kind) {
      case "RegExp":
      case "Number":
      case "String":
      case "Boolean":
      case "ArrayBuffer":
        return;
      case "Date":
        let dateValue = val.$DateValue;
        invariant(dateValue !== undefined);
        this.visitValue(dateValue);
        return;
      case "Float32Array":
      case "Float64Array":
      case "Int8Array":
      case "Int16Array":
      case "Int32Array":
      case "Uint8Array":
      case "Uint16Array":
      case "Uint32Array":
      case "Uint8ClampedArray":
      case "DataView":
        let buf = val.$ViewedArrayBuffer;
        invariant(buf !== undefined);
        this.visitValue(buf);
        return;
      case "Map":
      case "WeakMap":
        this.visitValueMap(val);
        return;
      case "Set":
      case "WeakSet":
        this.visitValueSet(val);
        return;
      default:
        if (kind !== "Object")
          this.logger.logError(val, `Object of kind ${kind} is not supported in residual heap.`);
        if (this.$ParameterMap !== undefined)
          this.logger.logError(val, `Arguments object is not supported in residual heap.`);
        return;
    }
  }

  visitValueSymbol(val: SymbolValue): void {
  }

  visitValueProxy(val: ProxyValue): void {
    this.visitValue(val.$ProxyTarget);
    this.visitValue(val.$ProxyHandler);
  }

  visitAbstractValue(val: AbstractValue): void {
    if (val.kind === "sentinel member expression")
      this.logger.logError(val, "expressions of type o[p] are not yet supported for partially known o and unknown p");
    for (let abstractArg of val.args)
      this.visitValue(abstractArg);
  }

  visitValue(val: Value): void {
    if (this.values.has(val)) return;
    this.values.add(val);
    if (val instanceof AbstractValue) {
      this.visitAbstractValue(val);
    } else if (val.isIntrinsic()) {
      this.visitValueIntrinsic(val);
    } else if (val instanceof EmptyValue) {
    } else if (ResidualHeapVisitor.isLeaf(val)) {
    } else if (IsArray(this.realm, val)) {
      invariant(val instanceof ObjectValue);
      this.visitValueArray(val);
    } else if (val instanceof ProxyValue) {
      this.visitValueProxy(val);
    } else if (val instanceof FunctionValue) {
      this.visitValueFunction(val);
    } else if (val instanceof SymbolValue) {
      this.visitValueSymbol(val);
    } else if (val instanceof ObjectValue) {
      this.visitValueObject(val);
    } else {
      invariant(false);
    }
  }

  visitGlobalBinding(key: string): VisitedBinding {
    let binding = this.globalBindings.get(key);
    if (!binding) {
      let value = this.realm.getGlobalLetBinding(key);
      binding = ({ global: true, value, modified: true }: VisitedBinding);
      this.globalBindings.set(key, binding);
      // Check for let binding vs global property
      if (value) this.visitValue(value);
    }
    return binding;
  }

  visitGenerator(generator: Generator): void {
    generator.visit(this.visitValue.bind(this));
  }

  visitRoots(): void {
    if (this.realm.generator) this.visitGenerator(this.realm.generator);
    for (let [, moduleValue] of this.modules.initializedModules)
      this.visitValue(moduleValue);
  }
}
