import type {
  Reducer,
  Action,
  PayloadAction,
  StoreEnhancer,
  Middleware,
} from '@reduxjs/toolkit'
import {
  isAction,
  applyMiddleware,
  createSlice,
  nanoid,
  SHOULD_AUTOBATCH,
  isPlainObject,
} from '@reduxjs/toolkit'
import { promiseTry } from '../utils'

interface PersistState {
  hydrated: boolean
  registered: boolean | 'conflict'
}

interface PersistorOptions<ReducerPath extends string = 'persistor'> {
  reducerPath?: ReducerPath
  onError?: (error: unknown) => void
}

interface PersistStorage<Serialized> {
  getItem(key: string): Promise<Serialized | null>
  setItem(key: string, value: Serialized): Promise<void>
  removeItem(key: string): Promise<void>
}

/* eslint-disable no-restricted-globals */
export const localStorage: PersistStorage<string> = {
  getItem(key) {
    return promiseTry(() => globalThis.localStorage.getItem(key))
  },
  setItem(key, value) {
    return promiseTry(() => globalThis.localStorage.setItem(key, value))
  },
  removeItem(key) {
    return promiseTry(() => globalThis.localStorage.removeItem(key))
  },
}
/* eslint-enable no-restricted-globals */

export type StateMerger<State, Serialized> = (
  inboundState: State,
  originalState: State | undefined,
  reducedState: State,
  config: PersistConfig<State, Serialized>
) => State

interface PersistConfig<State, Serialized> {
  storage: PersistStorage<Serialized>
  serialize?: ((state: State) => Serialized) | false
  deserialize?: ((serialized: Serialized) => State) | false
  merge?: StateMerger<State, Serialized>
}

interface PersistRegistryEntry {
  config: PersistConfig<any, any>
}

interface PersistDispatch<ReducerPath extends string> {
  (action: Action<`${ReducerPath}/startHydrate`>): Promise<void>
}

async function getStoredState(name: string, entry: PersistRegistryEntry) {
  let {
    config: { storage, deserialize },
  } = entry
  if (typeof deserialize === 'undefined') {
    deserialize = JSON.parse
  }

  const stored = await storage.getItem(name)

  return deserialize === false ? stored : deserialize(stored)
}

async function storeState(
  name: string,
  state: any,
  entry: PersistRegistryEntry
) {
  let {
    config: { storage, serialize },
  } = entry
  if (typeof serialize === 'undefined') {
    serialize = JSON.stringify
  }

  const serialized = serialize === false ? state : serialize(state)

  return storage.setItem(name, serialized)
}

export const hardMerge = <State>(inbound: State): State => inbound

export const shallowMerge = <State>(
  inbound: State,
  original: State | undefined,
  reduced: State
): State => {
  if (!isPlainObject(reduced)) return inbound
  const newState: State = { ...reduced }
  if (isPlainObject(inbound)) {
    const keys = Object.keys(inbound) as (keyof State)[]
    for (const key of keys) {
      if (original?.[key] !== reduced[key]) {
        // reducer has already modified the value, don't overwrite it
        continue
      }
      // otherwise take the inbound value
      newState[key] = inbound[key]
    }
  }
  return newState
}

export const twoLevelMerge = <State>(
  inbound: State,
  original: State | undefined,
  reduced: State
) => {
  if (!isPlainObject(reduced)) return inbound
  const newState: State = { ...reduced }
  if (isPlainObject(inbound)) {
    const keys = Object.keys(inbound) as (keyof State)[]
    for (const key of keys) {
      if (original?.[key] !== reduced[key]) {
        // reducer has already modified the value, don't overwrite it
        continue
      }
      // otherwise shallow merge the inbound value
      newState[key] = shallowMerge(inbound[key], original?.[key], reduced[key])
    }
  }
  return newState
}

export const createPersistor = <ReducerPath extends string = 'persistor'>({
  reducerPath = 'persistor' as ReducerPath,
  onError,
}: PersistorOptions<ReducerPath> = {}) => {
  const persistUid = nanoid()

  const internalRegistry: Record<string, PersistRegistryEntry> = {}

  const initialState: PersistState = { hydrated: false, registered: false }
  const slice = createSlice({
    name: reducerPath,
    initialState,
    reducers: {
      middlewareRegistered: (state, { payload }: PayloadAction<string>) => {
        state.registered =
          state.registered === 'conflict' || persistUid !== payload
            ? 'conflict'
            : true
      },
      hydrate: {
        prepare: (name: string, state: any) => ({
          payload: { name, state },
          meta: { [SHOULD_AUTOBATCH]: true },
        }),
        reducer(state, action: PayloadAction<{ name: string; state: any }>) {
          state.hydrated = true
        },
      },
      startHydrate: {
        prepare: () => ({
          payload: undefined,
          meta: { [SHOULD_AUTOBATCH]: true },
        }),
        reducer() {},
      },
      reset: () => initialState,
    },
    selectors: {
      selectRegistered: (state) => state.registered,
      selectHydrated: (state) => state.hydrated,
    },
  })

  const { middlewareRegistered, hydrate, startHydrate, reset } = slice.actions

  const { selectHydrated, selectRegistered } = slice.selectors

  const middleware: Middleware<
    PersistDispatch<ReducerPath>,
    { [K in ReducerPath]: PersistState }
  > = ({ dispatch, getState }) => {
    let initialized = false
    return (next) => (action) => {
      if (!initialized) {
        initialized = true
        dispatch(middlewareRegistered(persistUid))
      }
      const stateBefore = getState()
      if (isAction(action)) {
        if (reset.match(action)) {
          dispatch(middlewareRegistered(persistUid))
        } else if (hydrate.match(action)) {
          return Promise.all(
            Object.entries(internalRegistry).map(async ([name, entry]) => {
              try {
                const state = await getStoredState(name, entry)
                dispatch(hydrate(name, state))
              } catch (e) {
                onError?.(e)
              }
            })
          )
        } else if (
          typeof process !== 'undefined' &&
          process.env.NODE_ENV === 'development'
        ) {
          if (
            middlewareRegistered.match(action) &&
            action.payload === persistUid &&
            selectRegistered(getState()) === 'conflict'
          )
            console.error('whoops')
        }
      }
      const result = next(action)
      const stateAfter = getState()
      if (stateBefore !== stateAfter) {
        Object.entries(internalRegistry).forEach(([name, entry]) =>
          storeState(name, stateAfter, entry).catch(onError)
        )
      }
      return result
    }
  }

  const enhancer: StoreEnhancer<{ dispatch: PersistDispatch<ReducerPath> }> =
    (next) => (reducer, preloadedState) => {
      const createStore = applyMiddleware(middleware)(next)
      const store = createStore(reducer, preloadedState)

      store.dispatch(startHydrate())

      return store
    }

  const persistSlice = <S, A extends Action, SS>(
    { reducer, name }: { name: string; reducer: Reducer<S, A> },
    config: PersistConfig<S, SS>
  ): Reducer<S, A> => {
    const { merge = shallowMerge } = config
    internalRegistry[name] = { config }

    return function wrapped(state, action) {
      const reducedState = reducer(state, action)
      if (hydrate.match(action) && action.payload.name === name) {
        return merge(action.payload.state, state, reducedState, config)
      }
      return reducedState
    }
  }

  return {
    reducerPath,
    reducer: slice.reducer,
    persistSlice,
    enhancer,
  }
}

const persistor = createPersistor()

const counterSlice = persistor.persistSlice(
  createSlice({
    name: 'counter',
    initialState: 0,
    reducers: {
      increment: (state) => state + 1,
    },
  }),
  {
    storage: localStorage,
    merge: twoLevelMerge,
  }
)
