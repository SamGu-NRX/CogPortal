---
jupyter:
  jupytext:
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  kernelspec:
    display_name: Python [conda env:.conda-cogweb]
    language: python
    name: conda-env-.conda-cogweb-py
---

<!-- #raw raw_mimetype="text/restructuredtext" -->
.. meta::
   :description: Topic: Automatic differentiation, Category: Cheat Sheet
   :keywords: automatic differentiation, autodiff, gradient descent, pytorch, numpy, mygrad
<!-- #endraw -->

<!-- #region -->
# Automatic Differentiation and MyGrad

## Terminology

An **automatic differentiation** library provides us with mathematical functions and tools, which are specially designed so that, for any function that we evaluate, we can compute the corresponding (first-order) derivatives of that function.
PyTorch and TensorFlow are examples of popular libraries with "auto-diff" capabilities.
We will be using the **MyGrad library**, which is designed to be "NumPy with autodiff built in".

The **gradient** of a function is the collection (vector) of all of its (first-order) partial derivatives.
E.g. the gradient of the three-variable function $\mathscr{L}(w_1, w_2, w_3)$, is the vector of derivatives: $\nabla \vec{\mathscr{L}} = \begin{bmatrix} \frac{\partial \mathscr{L}}{\partial w_1} & \frac{\partial \mathscr{L}}{\partial w_2} & \frac{\partial \mathscr{L}}{\partial w_3} \end{bmatrix}$.

**Back-propagation** is a specific algorithm that can be used to perform automatic differentiation (via the chain rule in Calculus).
MyGrad leverages "backprop" under the hood when it computes derivatives.

For our purposes the terms **tensor** and **array** are synonymous and refer to multi-dimensional sequences of numbers.
MyGrad uses "tensors" where NumPy uses "arrays", because it is useful to be able to distinguish these types of objects in our code.

## Installing MyGrad
Install mygrad with

```python
pip install mygrad
```

The only dependency is NumPy.
<!-- #endregion -->

<!-- #region -->
## Creating tensors

```python
>>> import mygrad as mg

# creating a 0D tensor (a scalar)
>>> mg.tensor(0.)
Tensor(0.)

# creating a 1D tensor of 32-bit floats
>>> mg.tensor([1., 2., 3], dtype="float32")
Tensor([1., 2., 3.], dtype=float32)

# creating a constant tensor - meaning that this tensor
# will be skipped over during backpropagation
>>> x = mg.tensor([-2., -3.], constant=True)
>>> x.constant
True

# using a built-in tensor-creation function to 
# make create a sequence of numbers
>>> mg.linspace(0, 10, 5)
Tensor([ 0. ,  2.5,  5. ,  7.5, 10. ])
```
<!-- #endregion -->

<!-- #region -->
## Doing math with tensors

```python
>>> x = mg.tensor([[0., 1., 2.],
...                [3., 4., 5.]])

# square each element of the tensor
>>> x ** 2
Tensor([[ 0.,  1.,  4.],
        [ 9., 16., 25.]])

# or
>>> mg.square(x)
Tensor([[ 0.,  1.,  4.],
        [ 9., 16., 25.]])

# compute the square root of each element
# of the tensor, and force the output to be
# a constant
>>> mg.sqrt(x, constant=True)
Tensor([[0.        , 1.        , 1.41421356],
        [1.73205081, 2.        , 2.23606798]])

# take the dot product between all pairs of rows 
# of the tensor
>>> mg.matmul(x, x.T)
Tensor([[ 5., 14.],
        [14., 50.]])

# summing along the rows of the tensor
>>> x.sum(axis=1)
Tensor([ 3., 12.])

# or

>>> mg.sum(x, axis=1)
Tensor([ 3., 12.])
```
<!-- #endregion -->

<!-- #region -->
## Using automatic differentiation

### A single variable function
```python
# f(x) = 2 * x  @ x=10
>>> x = mg.tensor(10.0)
>>> f = 2 * x

# Calling `.backward()` on the final tensor
# of your calculation triggers auto-diff
# through the function(s) that created it
>>> f.backward()

# Stores df/dx @ x=10
>>> x.grad
array(2.)
```

### A multi-variable function

```python
# f(x, y) = x**2 + y  @ x=10, y=20
>>> x = mg.tensor(10.0)
>>> y = mg.tensor(20.0)
>>> f = x**2 + y

>>> f.backward()

# stores ∂f/∂x @ x=10, y=20
>>> x.grad
array(20.)

# stores ∂f/∂x @ x=10, y=20
>>> y.grad
array(1.)
```


### Vectorized autodiff

```python
# f(x) = x0**2 + x1**2 + x2**2  @ x0=-1, x1=4, x3=6 
x = mg.tensor([-1., 4., 6.])
f = mg.sum(x ** 2)

# stores [∂f/∂x0, ∂f/∂x1, ∂f/∂x2]  @ x0=-1, x1=4, x3=6 
>>> x.grad
array([-2.,  8., 12.])
```
<!-- #endregion -->

<!-- #region -->
## Working with constants
```python
# "Constant" tensors are skipped by automatic differentiation.
# This can save us from unnecessary computations
>>> constant_tensor = mg.tensor(2.0, constant=True)
>>> variable_tensor = mg.tensor(3.0)  # default: constant=False

>>> f = variable_tensor ** constant_tensor
>>> f.backward()  # compute df/d(variable_tensor), skip constant_tensor

>>> variable_tensor.grad
array(6.)
>>> constant_tensor.grad is None
True


# Integer-valued tensors *must* be treated as constants
>>> int_valued_tensor = mg.tensor([1, 2], dtype=int)
>>> int_valued_tensor.constant
True
>>> mg.tensor([1, 2], dtype=int, constant=False)  # not allowed
---------------------------------------------------------------------------
ValueError: Integer-valued tensors must be treated as constants.


# Operations on numpy arrays, lists, and other non-tensor objects will
# automatically return constants
>>> a_list = [1., 2.]  # lists are constants
>>> f = mg.sum(a_list)
>>> f.constant
True

>>> a_numpy_array = np.array([1., 2.])  # numpy-arrays are constants
>>> f = mg.sum(a_numpy_array)  
>>> f.backward()
>>> f.constant
True
>>> f.grad is None
True


```
<!-- #endregion -->

<!-- #region -->
## Reshaping tensors

```python
# making a shape-(2, 2) tensor
>>> x = mg.tensor([1.0, 2.0, 3.0, 4.0])
>>> x.reshape(2, 2)
Tensor([[1., 2.],
        [3., 4.]])

# or
>>> x.shape = (2, 2)
>>> x
Tensor([[1., 2.],
        [3., 4.]])

# transpose the tensor; swapping the rows
# and the columns
>>> x.T
Tensor([[1., 3.],
        [2., 4.]])
```

## Inspecting tensors

```python
>>> x = mg.tensor([[0., 1., 2.],
...                [3., 4., 5.]])

# What is your shape?
>>> x.shape
(3, 2)

# What is your dimensionality?
>>> x.ndim
2

# Are you a constant? I.e. will backprop "skip" you
# during autodiff?
>>> x.constant
False

# Gimme your underlying numpy array
>>> x.data
array([[0., 1., 2.],
       [3., 4., 5.]])

# or
>>> mg.asarray(x)
array([[0., 1., 2.],
       [3., 4., 5.]])

# Gimme me your associated derivatives (an array or None)
>>> x.grad
```
<!-- #endregion -->
